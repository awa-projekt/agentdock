import type { Client, InArgs, InStatement, ResultSet, Transaction, TransactionMode } from '@libsql/client';

const beginStatement = (mode: TransactionMode): string =>
  mode === 'write' ? 'BEGIN IMMEDIATE' : mode === 'read' ? 'BEGIN TRANSACTION READONLY' : 'BEGIN DEFERRED';

/**
 * `@libsql/client` hands its connection to every `transaction()` and lazily
 * opens a replacement for all other statements. Because libsql executes
 * statements synchronously, a statement on the replacement connection blocks
 * the event loop waiting for a write lock that only the open transaction can
 * release — so it stalls for the busy timeout and then fails with SQLITE_BUSY.
 * A replacement connection also drops connection state, which for `:memory:`
 * means a different, empty database.
 *
 * This wrapper runs transactions as BEGIN/COMMIT on the client's own
 * connection and serializes every statement behind a queue, so one connection
 * serves the whole process and nothing interleaves with an open transaction.
 */
export const withSerialQueue = (client: Client): Client => {
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const heldTransaction = (release: () => void): Transaction => {
    let open = true;
    const end = (statement: string) => {
      open = false;
      return client.execute(statement).then(
        () => {
          release();
        },
        (cause) => {
          release();
          throw cause;
        },
      );
    };
    return {
      get closed() {
        return !open;
      },
      execute: (stmt: InStatement) => client.execute(stmt),
      batch: (stmts: Array<InStatement>) => Promise.all(stmts.map((stmt) => client.execute(stmt))),
      executeMultiple: (sql: string) => client.executeMultiple(sql),
      commit: () => end('COMMIT'),
      rollback: () => end('ROLLBACK'),
      close: () => {
        if (open) void end('ROLLBACK').catch(() => {});
      },
    };
  };

  const beginTransaction = (mode: TransactionMode = 'write'): Promise<Transaction> =>
    new Promise<Transaction>((resolveTransaction, rejectTransaction) => {
      void enqueue(
        () =>
          new Promise<void>((release) => {
            client.execute(beginStatement(mode)).then(
              () => resolveTransaction(heldTransaction(() => release())),
              (cause) => {
                rejectTransaction(cause);
                release();
              },
            );
          }),
      );
    });

  function execute(stmt: InStatement): Promise<ResultSet>;
  function execute(sql: string, args?: InArgs): Promise<ResultSet>;
  function execute(stmt: InStatement, args?: InArgs): Promise<ResultSet> {
    if (args === undefined) return enqueue(() => client.execute(stmt));
    // SAFETY: only the `(sql, args)` overload supplies `args`, and it declares `stmt` as the SQL string.
    const sql = stmt as string;
    return enqueue(() => client.execute(sql, args));
  }

  return {
    execute,
    batch: (stmts, mode) => enqueue(() => client.batch(stmts, mode)),
    migrate: (stmts) => enqueue(() => client.migrate(stmts)),
    transaction: beginTransaction,
    executeMultiple: (sql) => enqueue(() => client.executeMultiple(sql)),
    sync: () => enqueue(() => client.sync()),
    close: () => client.close(),
    reconnect: () => client.reconnect(),
    get closed() {
      return client.closed;
    },
    get protocol() {
      return client.protocol;
    },
  };
};
