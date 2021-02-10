import { EventEmitter } from 'events';
import * as redis from 'redis';
import RedisMemoryServer from './RedisMemoryServer';
import { RedisMemoryServerOptsT } from './RedisMemoryServer';
import { generateDbName, getHost } from './util/db_util';
import { RedisBinaryOpts } from './util/RedisBinary';
import {
  RedisMemoryInstancePropT,
  RedisMemoryInstancePropBaseT,
  SpawnOptions,
  StorageEngineT,
} from './types';
import debug from 'debug';
import { RedisError } from 'redis';
import { deprecate } from 'util';

const log = debug('RedisMS:RedisMemoryReplSet');

/**
 * Replica set specific options.
 */
export interface ReplSetOpts {
  /**
   * enable auth ("--auth" / "--noauth")
   * @default false
   */
  auth?: boolean;
  /**
   * additional command line args passed to `redisd`
   * @default []
   */
  args?: string[];
  /**
   * number of `redisd` servers to start
   * @default 1
   */
  count?: number;
  /**
   * database name used in connection string
   * @default uuidv4()
   */
  dbName?: string;
  /**
   * bind to all IP addresses specify `::,0.0.0.0`
   * @default '127.0.0.1'
   */
  ip?: string;
  /**
   * replSet name
   * @default 'testset'
   */
  name?: string;
  /**
   * oplog size (in MB)
   * @default 1
   */
  oplogSize?: number;
  /**
   * Childprocess spawn options
   * @default {}
   */
  spawn?: SpawnOptions;
  /**
   *`redisd` storage engine type
   * @default 'ephemeralForTest'
   */
  storageEngine?: StorageEngineT;
  /**
   * Options for "rsConfig"
   * @default {}
   */
  configSettings?: RedisMemoryReplSetConfigSettingsT;
}

/**
 * Options for "rsConfig"
 */
export interface RedisMemoryReplSetConfigSettingsT {
  chainingAllowed?: boolean;
  heartbeatTimeoutSecs?: number;
  heartbeatIntervalMillis?: number;
  electionTimeoutMillis?: number;
  catchUpTimeoutMillis?: number;
}

/**
 * Options for the replSet
 */
export interface RedisMemoryReplSetOptsT {
  instanceOpts?: RedisMemoryInstancePropBaseT[];
  binary?: RedisBinaryOpts;
  replSet?: ReplSetOpts;
  /**
   * Auto-Start the replSet?
   * @default true
   */
  autoStart?: boolean;
}

/**
 * Class for managing an replSet
 */
export default class RedisMemoryReplSet extends EventEmitter {
  servers: RedisMemoryServer[] = [];
  opts: {
    instanceOpts: RedisMemoryInstancePropBaseT[];
    binary: RedisBinaryOpts;
    replSet: Required<ReplSetOpts>;
    autoStart?: boolean;
  };

  _state: 'init' | 'running' | 'stopped';

  constructor(opts: RedisMemoryReplSetOptsT = {}) {
    super();
    const replSetDefaults: Required<ReplSetOpts> = {
      auth: false,
      args: [],
      name: 'testset',
      count: 1,
      dbName: generateDbName(),
      ip: '127.0.0.1',
      oplogSize: 1,
      spawn: {},
      storageEngine: 'ephemeralForTest',
      configSettings: {},
    };
    this._state = 'stopped';
    this.opts = {
      binary: opts.binary || {},
      instanceOpts: opts.instanceOpts || [],
      replSet: { ...replSetDefaults, ...opts.replSet },
    };

    if (!this.opts.replSet.args) {
      this.opts.replSet.args = [];
    }
    this.opts.replSet.args.push('--oplogSize', `${this.opts.replSet.oplogSize}`);
    if (!(opts && opts.autoStart === false)) {
      log('Autostarting RedisMemoryReplSet.');
      setTimeout(() => this.start(), 0);
    }

    process.once('beforeExit', this.stop);
  }

  /**
   * Get the Connection String for redis to connect
   * @param otherDb use a different database than what was set on creation?
   * @deprecated
   */
  async getConnectionString(otherDb?: string | boolean): Promise<string> {
    return deprecate(
      this.getUri,
      '"RedisMemoryReplSet.getConnectionString" is deprecated, use ".getUri"',
      'MDEP001'
    ).call(this, otherDb);
  }

  /**
   * Returns database name.
   */
  async getDbName(): Promise<string> {
    // this function is only async for consistency with RedisMemoryServer
    // I don't see much point to either of them being async but don't
    // care enough to change it and introduce a breaking change.
    return this.opts.replSet.dbName;
  }

  /**
   * Returns instance options suitable for a RedisMemoryServer.
   * @param baseOpts Options to merge with
   */
  getInstanceOpts(baseOpts: RedisMemoryInstancePropBaseT = {}): RedisMemoryInstancePropT {
    const rsOpts: ReplSetOpts = this.opts.replSet;
    const opts: RedisMemoryInstancePropT = {
      auth: !!rsOpts.auth,
      args: rsOpts.args,
      dbName: rsOpts.dbName,
      ip: rsOpts.ip,
      replSet: rsOpts.name,
      storageEngine: rsOpts.storageEngine,
    };
    if (baseOpts.args) {
      opts.args = (rsOpts.args || []).concat(baseOpts.args);
    }
    if (baseOpts.port) {
      opts.port = baseOpts.port;
    }
    if (baseOpts.dbPath) {
      opts.dbPath = baseOpts.dbPath;
    }
    if (baseOpts.storageEngine) {
      opts.storageEngine = baseOpts.storageEngine;
    }
    log('   instance opts:', opts);
    return opts;
  }

  /**
   * Returns a redis: URI to connect to a given database.
   * @param otherDb use a different database than what was set on creation?
   */
  async getUri(otherDb?: string | boolean): Promise<string> {
    if (this._state === 'init') {
      await this._waitForPrimary();
    }
    if (this._state !== 'running') {
      throw new Error('Replica Set is not running. Use debug for more info.');
    }
    let dbName: string;
    if (otherDb) {
      dbName = typeof otherDb === 'string' ? otherDb : generateDbName();
    } else {
      dbName = this.opts.replSet.dbName;
    }
    const ports = await Promise.all(this.servers.map((s) => s.getPort()));
    const hosts = ports.map((port) => `127.0.0.1:${port}`).join(',');
    return `redis://${hosts}/${dbName}?replicaSet=${this.opts.replSet.name}`;
  }

  /**
   * Start underlying `redisd` instances.
   */
  async start(): Promise<void> {
    log('start');
    if (this._state !== 'stopped') {
      throw new Error(`Already in 'init' or 'running' state. Use debug for more info.`);
    }
    this.emit((this._state = 'init'));
    log('init');
    // Any servers defined within `opts.instanceOpts` should be started first as
    // the user could have specified a `dbPath` in which case we would want to perform
    // the `replSetInitiate` command against that server.
    const servers = this.opts.instanceOpts.map((opts) => {
      log('  starting server from instanceOpts:', opts, '...');
      return this._initServer(this.getInstanceOpts(opts));
    });
    const cnt = this.opts.replSet.count || 1;
    while (servers.length < cnt) {
      log(`  starting server ${servers.length + 1} of ${cnt}...`);
      const server = this._initServer(this.getInstanceOpts({}));
      servers.push(server);
    }
    // ensures all servers are listening for connection
    await Promise.all(servers.map((s) => s.start()));
    this.servers = servers;
    await this._initReplSet();
  }

  /**
   * Stop the underlying `redisd` instance(s).
   */
  async stop(): Promise<boolean> {
    if (this._state === 'stopped') {
      return false;
    }
    const servers = this.servers;
    this.servers = [];
    process.removeListener('beforeExit', this.stop); // many accumulate inside tests
    return Promise.all(servers.map((s) => s.stop()))
      .then(() => {
        this.emit((this._state = 'stopped'));
        return true;
      })
      .catch((err) => {
        log(err);
        this.emit((this._state = 'stopped'), err);
        return false;
      });
  }

  /**
   * Wait until all instances are running
   */
  async waitUntilRunning(): Promise<void> {
    // TODO: this seems like it dosnt catch if an instance fails, and runs forever
    if (this._state === 'running') {
      return;
    }
    await new Promise((resolve) => this.once('running', () => resolve()));
  }

  /**
   * Connects to the first server from the list of servers and issues the `replSetInitiate`
   * command passing in a new replica set configuration object.
   */
  async _initReplSet(): Promise<void> {
    if (this._state !== 'init') {
      throw new Error('Not in init phase.');
    }
    log('Initializing replica set.');
    if (!this.servers.length) {
      throw new Error('One or more servers are required.');
    }
    const uris = await Promise.all(this.servers.map((server) => server.getUri()));

    let RedisClient: typeof redis.RedisClient;
    try {
      RedisClient = (await import('redis')).RedisClient;
    } catch (e) {
      throw new Error(
        `You need to install "redis" package. It's required for checking ReplicaSet state.`
      );
    }

    const conn: redis.RedisClient = await RedisClient.connect(uris[0], {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    try {
      const db = await conn.db(this.opts.replSet.dbName);

      // RedisClient HACK which helps to avoid the following error:
      //   "RangeError: Maximum call stack size exceeded"
      // (db as any).topology.shouldCheckForSessionSupport = () => false; // TODO: remove after 1.1.2021 if no issues arise

      /** reference to "db.admin()" */
      const admin = db.admin();
      const members = uris.map((uri, idx) => ({ _id: idx, host: getHost(uri) }));
      const rsConfig = {
        _id: this.opts.replSet.name,
        members,
        settings: {
          electionTimeoutMillis: 500,
          ...(this.opts.replSet.configSettings || {}),
        },
      };
      try {
        await admin.command({ replSetInitiate: rsConfig });
      } catch (e) {
        if (e instanceof RedisError && e.errmsg == 'already initialized') {
          log(`${e.errmsg}: trying to set old config`);
          const { config: oldConfig } = await admin.command({ replSetGetConfig: 1 });
          log('got old config:\n', oldConfig);
          await admin.command({
            replSetReconfig: oldConfig,
            force: true,
          });
        } else {
          throw e;
        }
      }
      log('Waiting for replica set to have a PRIMARY member.');
      await this._waitForPrimary();
      this.emit((this._state = 'running'));
      log('running');
    } finally {
      await conn.close();
    }
  }

  /**
   * Create the one Instance (without starting them)
   * @param instanceOpts Instance Options to use for this instance
   */
  _initServer(instanceOpts: RedisMemoryInstancePropT): RedisMemoryServer {
    const serverOpts: RedisMemoryServerOptsT = {
      autoStart: false,
      binary: this.opts.binary,
      instance: instanceOpts,
      spawn: this.opts.replSet.spawn,
    };
    const server = new RedisMemoryServer(serverOpts);
    return server;
  }

  /**
   * Wait until the replSet has elected an Primary
   * @param timeout Timeout to not run infinitly
   */
  async _waitForPrimary(timeout: number = 30000): Promise<void> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject('Timed out in ' + timeout + 'ms. When waiting for primary.');
      }, timeout);
    });

    await Promise.race([
      ...this.servers.map((server) => {
        const instanceInfo = server.getInstanceInfo();
        if (!instanceInfo) {
          throw new Error('_waitForPrimary - instanceInfo not present ');
        }
        return instanceInfo.instance.waitPrimaryReady();
      }),
      timeoutPromise,
    ]);

    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }

    log('_waitForPrimary detected one primary instance ');
  }
}
