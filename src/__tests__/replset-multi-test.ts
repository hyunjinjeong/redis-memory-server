import RedisMemoryReplSet from '../RedisMemoryReplSet';
import { RedisClient } from 'redis';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 600000;

describe('multi-member replica set', () => {
  it('should enter running state', async () => {
    const opts: any = { replSet: { count: 3 } };
    const replSet = new RedisMemoryReplSet(opts);
    await replSet.waitUntilRunning();
    expect(replSet.servers.length).toEqual(3);
    const uri = await replSet.getUri();
    expect(uri.split(',').length).toEqual(3);

    await replSet.stop();
  }, 40000);

  it('should be possible to connect replicaset after waitUntilRunning resolveds', async () => {
    const opts: any = { replSet: { count: 3 } };
    const replSet = new RedisMemoryReplSet(opts);
    await replSet.waitUntilRunning();
    const uri = await replSet.getUri();

    const conn = await RedisClient.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    // await while all SECONDARIES will be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const db = await conn.db(await replSet.getDbName());
    const admin = db.admin();
    const status = await admin.replSetGetStatus();
    expect(status.members.filter((m: any) => m.stateStr === 'PRIMARY')).toHaveLength(1);
    expect(status.members.filter((m: any) => m.stateStr === 'SECONDARY')).toHaveLength(2);

    await replSet.stop();
  });
});
