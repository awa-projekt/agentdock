import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { withSerialQueue } from './serial-client';

const makeClient = async () => {
  const client = withSerialQueue(createClient({ url: ':memory:' }));
  await client.execute('create table item (id integer primary key, name text)');
  return client;
};

describe('withSerialQueue', () => {
  it('runs statements issued while a transaction is open', async () => {
    const client = await makeClient();

    const transaction = await client.transaction('write');
    const concurrentInsert = client.execute({ sql: 'insert into item (name) values (?)', args: ['outside'] });
    await transaction.execute({ sql: 'insert into item (name) values (?)', args: ['inside'] });
    await transaction.commit();
    await concurrentInsert;

    const rows = await client.execute('select name from item order by id');
    expect(rows.rows.map((row) => row.name)).toEqual(['inside', 'outside']);
  });

  it('keeps overlapping transactions from interleaving', async () => {
    const client = await makeClient();

    const insertIn = async (name: string) => {
      const transaction = await client.transaction('write');
      await transaction.execute({ sql: 'insert into item (name) values (?)', args: [`${name}-first`] });
      await transaction.execute({ sql: 'insert into item (name) values (?)', args: [`${name}-second`] });
      await transaction.commit();
    };

    await Promise.all([insertIn('a'), insertIn('b')]);

    const rows = await client.execute('select name from item order by id');
    expect(rows.rows.map((row) => row.name)).toEqual(['a-first', 'a-second', 'b-first', 'b-second']);
  });

  it('rolls back without stranding later statements', async () => {
    const client = await makeClient();

    const transaction = await client.transaction('write');
    await transaction.execute({ sql: 'insert into item (name) values (?)', args: ['dropped'] });
    await transaction.rollback();

    await client.execute({ sql: 'insert into item (name) values (?)', args: ['kept'] });
    const rows = await client.execute('select name from item');
    expect(rows.rows.map((row) => row.name)).toEqual(['kept']);
  });

  it('releases the queue when a transaction body fails', async () => {
    const client = await makeClient();

    await expect(
      client.transaction('write').then(async (transaction) => {
        try {
          await transaction.execute('insert into missing_table (name) values (1)');
        } finally {
          await transaction.rollback();
        }
      }),
    ).rejects.toThrow();

    await client.execute({ sql: 'insert into item (name) values (?)', args: ['after-failure'] });
    const rows = await client.execute('select name from item');
    expect(rows.rows.map((row) => row.name)).toEqual(['after-failure']);
  });
});
