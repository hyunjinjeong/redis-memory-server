import { ChildProcess } from 'child_process';
import { default as spawnChild } from 'cross-spawn';
import path from 'path';
import RedisBinary from './RedisBinary';
import { RedisBinaryOpts } from './RedisBinary';
import {
  StorageEngineT,
  SpawnOptions,
  DebugFn,
  ErrorVoidCallback,
  EmptyVoidCallback,
} from '../types';
import debug from 'debug';
import { isNullOrUndefined } from './db_util';
import { lt } from 'semver';

if (lt(process.version, '10.15.0')) {
  console.warn('Using NodeJS below 10.15.0');
}

const log = debug('RedisMS:RedisInstance');

export interface RedisdOps {
  // instance options
  instance: {
    port?: number;
    ip?: string; // for binding to all IP addresses set it to `::,0.0.0.0`, by default '127.0.0.1'
    storageEngine?: StorageEngineT;
    dbPath?: string;
    replSet?: string;
    args?: string[];
    auth?: boolean;
  };

  // redis binary options
  binary?: RedisBinaryOpts;

  // child process spawn options
  spawn?: SpawnOptions;
}

/**
 * Redis Instance Handler Class
 */
export default class RedisInstance {
  static childProcessList: ChildProcess[] = [];
  opts: RedisdOps;
  debug: DebugFn;

  childProcess: ChildProcess | null;
  killerProcess: ChildProcess | null;
  waitForPrimaryResolveFns: ((value: boolean) => void)[];
  isInstancePrimary: boolean = false;
  isInstanceReady: boolean = false;
  instanceReady: EmptyVoidCallback = () => {};
  instanceFailed: ErrorVoidCallback = () => {};

  constructor(opts: RedisdOps) {
    this.opts = opts;
    this.childProcess = null;
    this.killerProcess = null;
    this.waitForPrimaryResolveFns = [];

    if (!this.opts.instance) {
      this.opts.instance = {};
    }
    if (!this.opts.binary) {
      this.opts.binary = {};
    }

    if (debug.enabled('RedisMS:RedisInstance')) {
      // add instance's port to debug output
      const port = this.opts.instance?.port;
      this.debug = (msg: string): void => {
        log(`Redis[${port}]: ${msg}`);
      };
    } else {
      this.debug = () => {};
    }
  }

  /**
   * Create an new instance an call method "run"
   * @param opts Options passed to the new instance
   */
  static async run(opts: RedisdOps): Promise<RedisInstance> {
    const instance = new this(opts);
    return instance.run();
  }

  /**
   * Create an array of arguments for the redisd instance
   */
  prepareCommandArgs(): string[] {
    const { ip, port, storageEngine, dbPath, replSet, auth, args } = this.opts.instance;

    const result: string[] = [];
    result.push('--bind_ip', ip || '127.0.0.1');
    if (port) {
      result.push('--port', port.toString());
    }
    if (storageEngine) {
      result.push('--storageEngine', storageEngine);
    }
    if (dbPath) {
      result.push('--dbpath', dbPath);
    }
    if (!auth) {
      result.push('--noauth');
    } else if (auth) {
      result.push('--auth');
    }
    if (replSet) {
      result.push('--replSet', replSet);
    }

    return result.concat(args ?? []);
  }

  /**
   * Create the redisd process
   */
  async run(): Promise<this> {
    const launch = new Promise((resolve, reject) => {
      this.instanceReady = () => {
        this.isInstanceReady = true;
        this.debug('RedisInstance: Instance is ready!');
        resolve({ ...this.childProcess });
      };
      this.instanceFailed = (err: any) => {
        this.debug(`RedisInstance: Instance has failed: ${err.toString()}`);
        if (this.killerProcess) {
          this.killerProcess.kill();
        }
        reject(err);
      };
    });

    const redisBin = await RedisBinary.getPath(this.opts.binary);
    this.childProcess = this._launchRedisd(redisBin);
    this.killerProcess = this._launchKiller(process.pid, this.childProcess.pid);

    await launch;
    return this;
  }

  async kill(): Promise<RedisInstance> {
    this.debug('Called RedisInstance.kill():');

    /**
     * Function to De-Duplicate Code
     * @param process The Process to kill
     * @param name the name used in the logs
     * @param debugfn the debug function
     */
    async function kill_internal(process: ChildProcess, name: string, debugfn: DebugFn) {
      const timeoutTime = 1000 * 10;
      await new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
          debugfn('kill_internal timeout triggered, trying SIGKILL');
          if (!debug.enabled('RedisMS:RedisInstance')) {
            console.warn(
              'An Process didnt exit with signal "SIGINT" within 10 seconds, using "SIGKILL"!\n' +
                'Enable debug logs for more information'
            );
          }
          process.kill('SIGKILL');
          timeout = setTimeout(() => {
            debugfn('kill_internal timeout triggered again, rejecting');
            reject(new Error('Process didnt exit, enable debug for more information.'));
          }, timeoutTime);
        }, timeoutTime);
        process.once(`exit`, (code, signal) => {
          debugfn(`- ${name}: got exit signal, Code: ${code}, Signal: ${signal}`);
          clearTimeout(timeout);
          resolve();
        });
        debugfn(`- ${name}: send "SIGINT"`);
        process.kill('SIGINT');
      });
    }

    if (!isNullOrUndefined(this.childProcess)) {
      await kill_internal(this.childProcess, 'childProcess', this.debug);
    } else {
      this.debug('- childProcess: nothing to shutdown, skipping.');
    }
    if (!isNullOrUndefined(this.killerProcess)) {
      await kill_internal(this.killerProcess, 'killerProcess', this.debug);
    } else {
      this.debug('- killerProcess: nothing to shutdown, skipping.');
    }

    this.debug('Instance Finished Shutdown');

    return this;
  }

  /**
   * Get the PID of the redisd instance
   */
  getPid(): number | undefined {
    return this.childProcess?.pid;
  }

  /**
   * Wait until the Primary redisd is running
   */
  async waitPrimaryReady(): Promise<boolean> {
    if (this.isInstancePrimary) {
      return true;
    }
    return new Promise((resolve) => {
      this.waitForPrimaryResolveFns.push(resolve);
    });
  }

  /**
   * Actually launch redisd
   * @param redisBin The binary to run
   */
  _launchRedisd(redisBin: string): ChildProcess {
    const spawnOpts = this.opts.spawn ?? {};
    if (!spawnOpts.stdio) {
      spawnOpts.stdio = 'pipe';
    }

    const childProcess = spawnChild(redisBin, this.prepareCommandArgs(), spawnOpts);
    childProcess.stderr?.on('data', this.stderrHandler.bind(this));
    childProcess.stdout?.on('data', this.stdoutHandler.bind(this));
    childProcess.on('close', this.closeHandler.bind(this));
    childProcess.on('error', this.errorHandler.bind(this));

    if (isNullOrUndefined(childProcess.pid)) {
      throw new Error('Spawned Redis Instance PID is undefined');
    }

    return childProcess;
  }

  /**
   * Spawn an child to kill the parent and the redisd instance if both are Dead
   * @param parentPid Parent to kill
   * @param childPid Redisd process to kill
   */
  _launchKiller(parentPid: number, childPid: number): ChildProcess {
    this.debug(`Called RedisInstance._launchKiller(parent: ${parentPid}, child: ${childPid}):`);
    // spawn process which kills itself and redis process if current process is dead
    const killer = spawnChild(
      process.env['NODE'] ?? process.argv[0], // try Environment variable "NODE" before using argv[0]
      [
        path.resolve(__dirname, '../../scripts/redis_killer.js'),
        parentPid.toString(),
        childPid.toString(),
      ],
      { stdio: 'pipe' }
    );

    killer.stdout?.on('data', (data) => {
      this.debug(`[RedisKiller]: ${data}`);
    });

    killer.stderr?.on('data', (data) => {
      this.debug(`[RedisKiller]: ${data}`);
    });

    ['exit', 'message', 'disconnect', 'error'].forEach((type) => {
      killer.on(type, (...args) => {
        this.debug(`[RedisKiller]: ${type} - ${JSON.stringify(args)}`);
      });
    });

    return killer;
  }

  errorHandler(err: string): void {
    this.instanceFailed(err);
  }

  /**
   * Write the CLOSE event to the debug function
   * @param code The Exit code
   */
  closeHandler(code: number): void {
    if (code != 0) {
      this.debug('Redisd instance closed with an non-0 code!');
    }
    this.debug(`CLOSE: ${code}`);
    this.instanceFailed(`Redisd instance closed with code "${code}"`);
  }

  /**
   * Write STDERR to debug function
   * @param message The STDERR line to write
   */
  stderrHandler(message: string | Buffer): void {
    this.debug(`STDERR: ${message.toString()}`);
  }

  /**
   * Write STDOUT to debug function AND instanceReady/instanceFailed if inputs match
   * @param message The STDOUT line to write/parse
   */
  stdoutHandler(message: string | Buffer): void {
    const line: string = message.toString();
    this.debug(`STDOUT: ${line}`);

    if (/waiting for connections/i.test(line)) {
      this.instanceReady();
    } else if (/addr already in use/i.test(line)) {
      this.instanceFailed(`Port ${this.opts.instance.port} already in use`);
    } else if (/redisd instance already running/i.test(line)) {
      this.instanceFailed('Redisd already running');
    } else if (/permission denied/i.test(line)) {
      this.instanceFailed('Redisd permission denied');
    } else if (/Data directory .*? not found/i.test(line)) {
      this.instanceFailed('Data directory not found');
    } else if (/CURL_OPENSSL_3.*not found/i.test(line)) {
      this.instanceFailed(
        'libcurl3 is not available on your system. Redisd requires it and cannot be started without it.\n' +
          'You should manually install libcurl3 or try to use an newer version of Redis\n'
      );
    } else if (/CURL_OPENSSL_4.*not found/i.test(line)) {
      this.instanceFailed(
        'libcurl4 is not available on your system. Redisd requires it and cannot be started without it.\n' +
          'You need to manually install libcurl4\n'
      );
    } else if (/shutting down with code/i.test(line)) {
      // if redisd started succesfully then no error on shutdown!
      if (!this.isInstanceReady) {
        this.instanceFailed('Redisd shutting down');
      }
    } else if (/\*\*\*aborting after/i.test(line)) {
      this.instanceFailed('Redisd internal error');
    } else if (/transition to primary complete; database writes are now permitted/i.test(line)) {
      this.isInstancePrimary = true;
      this.debug('Calling all waitForPrimary resolve functions');
      this.waitForPrimaryResolveFns.forEach((resolveFn) => resolveFn(true));
    }
  }
}
