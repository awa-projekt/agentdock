@effect/platform provides a type safe API for anything required in a TypeScript backend:

HTTP client shared type safe definitions
Integration for any database
Runtime agnostic
Support for features like env variables, OpenAPI, middlewares and more
And it's actually easy to get started. In this article I will show you how to set up an effect backend:

Type safe API definition
Database integration (postgres)
Environmental variables
Deriving type safe client
Open Source Repository
Shared API definition
@effect/platform allows to keep the shape of the API independent of the actual implementation:

Define API structure before the implementation (endpoints, methods, payloads, etc.)
Create multiple implementations all conforming to the same shape (e.g. for testing)
Type-safe definitions make the implementation easier
Full type safety between client and server (shared types, similar to something like tRPC)
Since the API definition is shared between server and client, I suggest keeping it in a separate package inside a monorepo.

Each API endpoint is contained inside an HttpApiGroup:

import { HttpApiGroup } from "@effect/platform";

class UserGroup extends HttpApiGroup.make("user") {}


HttpApiGroup groups a set of related endpoints (e.g. "user", "product"). Each endpoint is defined by calling add after make:

class UserGroup extends HttpApiGroup.make("user")
  .add( /* endpoint 1 */ )
  .add( /* endpoint 2 */ )
  .add( /* endpoint 3 */ ) {}


Inside add we pass an instance of HttpApiEndpoint. In the example below:

POST endpoint
/user/create path
Payload { name: string }
Shape of errors (string)
Success response
Payloads are defined using Schema from effect, which includes encode/decode by default (with validation) 🪄

import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";

class UserGroup extends HttpApiGroup.make("user").add(
  // Method (`post`), identifier (`createUser`), path (`/user/create`)
  HttpApiEndpoint.post("createUser")`/user/create`
    .setPayload(Schema.Struct({ name: Schema.String }))
    .addError(Schema.String)
    .addSuccess(Schema.UUID)
) {}


Since all parameters are defined as Schema, we can also create a custom response schema:

import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

export class User extends Schema.Class<User>("User")({
  id: Schema.Number,
  name: Schema.String,
  created_at: Schema.DateFromSelf,
}) {}

class UserGroup extends HttpApiGroup.make("user").add(
  HttpApiEndpoint.post("createUser")`/user/create`
    .setPayload(Schema.Struct({ name: Schema.String }))
    .addError(Schema.String)
    .addSuccess(User) // 👈 Schema response
) {}


You can chain multiple calls of add to include multiple endpoints in a group:

HttpApiSchema.param makes path parameters type safe

class UserGroup extends HttpApiGroup.make("user")
  .add(
    HttpApiEndpoint.post("createUser")`/user/create`
      .setPayload(Schema.Struct({ name: Schema.String }))
      .addError(Schema.String)
      .addSuccess(User)
  )
  .add(
    HttpApiEndpoint.get(
      "getUser"
    )`/user/get/${HttpApiSchema.param("id", Schema.NumberFromString)}`
      .addError(Schema.String)
      .addSuccess(User)
  ) {}


Export HttpApi
Multiple groups are collected in a single HttpApi, which defines the full shape of the API:

import { HttpApi } from "@effect/platform";

export class ServerApi extends HttpApi.make("server-api") {}


Each group is added by chaining calls to add after make:

export class ServerApi extends HttpApi.make("server-api")
  .add(UserGroup) {}


Exporting ServerApi makes it accessible to both server and client:

Server: define actual API implementation
Client: derive type-safe client for making HTTP requests
Below the final result. Notice how we didn't define any implementation, but instead just declared a full type safe structure for our API:

You can explore more API options inside @effect/platform API definition and on the effect documentation

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

export class User extends Schema.Class<User>("User")({
  id: Schema.Number,
  name: Schema.String,
  created_at: Schema.DateFromSelf,
}) {}

class UserGroup extends HttpApiGroup.make("user")
  .add(
    HttpApiEndpoint.post("createUser")`/user/create`
      .setPayload(Schema.Struct({ name: Schema.String }))
      .addError(Schema.String)
      .addSuccess(User)
  )
  .add(
    HttpApiEndpoint.get(
      "getUser"
    )`/user/get/${HttpApiSchema.param("id", Schema.NumberFromString)}`
      .addError(Schema.String)
      .addSuccess(User)
  ) {}

export class ServerApi extends HttpApi.make("server-api").add(UserGroup) {}


Backend API implementation
The backend implementation is part of a separate project that imports the above API definition (monorepo).

Example of monorepo setup. The shared "packages/api" contains the previous API definition. "apps/server" imports "packages/api" to define the implementation of the API.
Example of monorepo setup. The shared "packages/api" contains the previous API definition. "apps/server" imports "packages/api" to define the implementation of the API.
The implementation is defined using HttpApiBuilder:

HttpApiBuilder creates a Layer for each API group.

If you want to learn more about effect and Layer, check out Effect: Beginners Complete Getting Started.

import { HttpApiBuilder } from "@effect/platform";
import { ServerApi } from "@local/api"; // 👈 API definition from shared package

export const UserGroupLive = HttpApiBuilder.group(
  ServerApi,
  "user", // 👈 Implementation for the "user" group (only!)
  (handlers) => /* Implementation */
);


handlers is used to implement each endpoint (by calling handle):

handle references the identifier of each endpoint, and gives access to payload/headers/path according to the definition (type safe) 🪄

export const UserGroupLive = HttpApiBuilder.group(
  ServerApi,
  "user",
  (handlers) =>
    handlers
      .handle("createUser", ({ payload }) => /* Implementation */ )
      .handle("getUser", ({ path }) => /* Implementation */ )
);


The implementation requires to return an Effect with the success and error types according to the shared definition.

In this example, both endpoint must return a User, or error with string (i.e. Effect<User, string, R>).

R can be any dependency. We will see later in the article how access the database and perform SQL queries 👇

export const UserGroupLive = HttpApiBuilder.group(
  ServerApi,
  "user",
  (handlers) =>
    handlers
      .handle("createUser", ({ payload }) =>
        Effect.gen(function* () {
          // Do something, return a `User`
        }).pipe(
          // 👇 Make sure that errors are `string`
          Effect.mapError(() => "Some error happened!")
        )
      )
      .handle("getUser", ({ path }) =>
        Effect.gen(function* () {
          // ....
        })
      )
);


Running API server
The @effect/platform API is generic, not specific to any runtime.

This means that you can run the API with any runtime you prefer, the implementation stays the same 🪄

Effect provides packages specific for each runtime. In this example, we use NodeJs with @effect/platform-node.

We call HttpApiBuilder.api to build the final Layer for the whole API (ServerApi):

import { Layer } from "effect";
import { HttpApiBuilder } from "@effect/platform";
import { ServerApi } from "@local/api";

import { UserGroupLive } from "./user";

const MainApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide([UserGroupLive /* ...list other groups */ ]),
);


Inside HttpApiBuilder.serve we include all the services specific to @effect/platform-node that run the server API:

import { HttpApiBuilder } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { ServerApi } from "@local/api";
import { Layer } from "effect";

import { createServer } from "node:http";

import { UserGroupLive } from "./user";

const MainApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide([UserGroupLive])
);

const HttpLive = HttpApiBuilder.serve().pipe(
  Layer.provide(MainApiLive), // API definition
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })) // Node server configuration
);


The final step is launching the API using NodeRuntime:

import { HttpApiBuilder } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ServerApi } from "@local/api";
import { Layer } from "effect";

import { createServer } from "node:http";

import { UserGroupLive } from "./user";

const MainApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide([UserGroupLive])
);

const HttpLive = HttpApiBuilder.serve().pipe(
  Layer.provide(MainApiLive), // API definition
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })) // Node server configuration
);

NodeRuntime.runMain(Layer.launch(HttpLive));


For running the server you can execute the above file using something like tsx.

This it all! Now you have a full type safe backend working with effect 🚀

Using a different runtime
As mentioned, you are not required to use NodeJs.

Effect provides other packages specific for different runtimes. Wanna try Bun? Use @effect/platform-bun.

Everything works without changes in the API definition or implementation 🪄

// 👇 `platform-bun` instead of `platform-node`, nothing more!
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";

const MainApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide([UserGroupLive])
);

const HttpLive = HttpApiBuilder.serve().pipe(
  Layer.provide(MainApiLive),
  Layer.provide(BunHttpServer.layer({ port: 3000 }))
);

BunRuntime.runMain(Layer.launch(HttpLive));


Database setup
A core component of any backend is a database connection. You can implement this in effect using @effect/sql.

Similar to @effect/platform, also @effect/sql is a generic package to implement SQL queries. The specific implementation depends on your database.

In this example, we use @effect/sql-pg for a Postgres Database. We start by defining a Layer for a SQL client with postgres:

import { PgClient } from "@effect/sql-pg";
import { Config } from "effect";

export const DatabaseLive = PgClient.layerConfig({
  password: Config.redacted("POSTGRES_PW"),
  username: Config.succeed("postgres"),
  database: Config.succeed("postgres"),
  host: Config.succeed("localhost"),
  port: Config.succeed(5435),
});


We just need to provide it to UserGroupLive to have access to SQL inside the API group:

export const UserGroupLive = HttpApiBuilder.group(
  ServerApi,
  "user",
  (handlers) => // ...
).pipe(
  Layer.provide(DatabaseLive)
);


Executing SQL queries
Inside UserGroupLive we can now access SqlClient from @effect/sql:

import { SqlClient } from "@effect/sql";

export const UserGroupLive = HttpApiBuilder.group(
  ServerApi,
  "user",
  (handlers) =>
    handlers
      .handle("createUser", ({ payload }) =>
        Effect.gen(function* () {
          // Generic SQL client
          const sql = yield* SqlClient.SqlClient;

          // ...
        })
      )
      .handle("getUser", ({ path }) => /* ... */ )
).pipe(Layer.provide(DatabaseLive));


We can use SqlClient to write type safe queries which are independent of the database used.

export const UserGroupLive = HttpApiBuilder.group(
  ServerApi,
  "user",
  (handlers) =>
    handlers
      .handle("createUser", ({ payload }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const GetById = yield* SqlResolver.findById("GetUserById", {
            Id: Schema.Number,
            Result: User,
            ResultId: (_) => _.id,
            execute: (ids) =>
              sql`SELECT * FROM "user" WHERE ${sql.in("id", ids)}`,
          });

          const getById = flow(
            GetById.execute,
            Effect.withRequestCaching(true)
          );

          return yield* getById(path.id).pipe(
            Effect.flatMap(Function.identity)
          );
        })
      )
      .handle("getUser", ({ path }) => /* ... */ )
).pipe(Layer.provide(DatabaseLive));


Providing environmental variables
The final step is providing Config variables for the database configuration (e.g. username, password):

// 👇 In this example, we need to provide a value for `POSTGRES_PW`
export const DatabaseLive = PgClient.layerConfig({
  password: Config.redacted("POSTGRES_PW"),
  username: Config.succeed("postgres"),
  database: Config.succeed("postgres"),
  host: Config.succeed("localhost"),
  port: Config.succeed(5435),
});


Effect includes dotenv support out of the box using PlatformConfigProvider.fromDotEnv:

import { PlatformConfigProvider } from "@effect/platform";

// Read from `.env` file
const effect = PlatformConfigProvider.fromDotEnv(".env");


fromDotEnv returns an Effect that reads the given env file and extracts ConfigProvider.

We use Layer.setConfigProvider+Layer.unwrapEffect to create a Layer for the provider:

const EnvProviderLayer = Layer.unwrapEffect(
  PlatformConfigProvider.fromDotEnv(".env").pipe(
    Effect.map(Layer.setConfigProvider),
    Effect.provide(NodeFileSystem.layer) // Required dependencies to read file system
  )
);


We provide EnvProviderLayer to instruct effect to read from the given env configuration when running the server:

const EnvProviderLayer = Layer.unwrapEffect(
  PlatformConfigProvider.fromDotEnv(".env").pipe(
    Effect.map(Layer.setConfigProvider),
    Effect.provide(NodeFileSystem.layer)
  )
);

const MainApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide([UserGroupLive]),
  Layer.provide(EnvProviderLayer)
);

const HttpLive = HttpApiBuilder.serve().pipe(
  Layer.provide(MainApiLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
);

NodeRuntime.runMain(Layer.launch(HttpLive));


Database migrations
Effect also provides modules to automatically handle database migrations.

Just like before, we create a Layer that defines how the migration is executed. We use PgMigrator from @effect/sql-pg:

import { PgMigrator } from "@effect/sql-pg";
import { fileURLToPath } from "node:url";

export const MigratorLive = PgMigrator.layer({
  // Where to put the `_schema.sql` file
  schemaDirectory: "src/migrations",
  loader: PgMigrator.fromFileSystem(
    fileURLToPath(new URL("migrations", import.meta.url))
  ),
});


PgMigrator needs access to the file system and the database client. We provide both using Layer.provide:

import { NodeContext } from "@effect/platform-node";
import { PgMigrator } from "@effect/sql-pg";
import { Layer } from "effect";
import { fileURLToPath } from "node:url";
import { DatabaseLive } from "./database";

export const MigratorLive = PgMigrator.layer({
  // Where to put the `_schema.sql` file
  schemaDirectory: "src/migrations",
  loader: PgMigrator.fromFileSystem(
    fileURLToPath(new URL("migrations", import.meta.url))
  ),
}).pipe(
  Layer.provide([DatabaseLive, NodeContext.layer])
);


loader points to the folder where the migration files are defined (./migrations in the example). Inside the folder we define files that return Effect containing the migration implementation:

The "migrations" folder contains the list of all the migrations. Each file exports an Effect that executes the migration.
The "migrations" folder contains the list of all the migrations. Each file exports an Effect that executes the migration.
0001_create_tables.ts
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    CREATE TABLE "user" (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `
);


The final step is providing the MigratorLive layer (just like we did before for all the other components 💁🏼‍♂️):

const EnvProviderLayer = Layer.unwrapEffect(
  PlatformConfigProvider.fromDotEnv(".env").pipe(
    Effect.map(Layer.setConfigProvider),
    Effect.provide(NodeFileSystem.layer)
  )
);

const MainApiLive = HttpApiBuilder.api(ServerApi).pipe(
  Layer.provide([MigratorLive, UserGroupLive]),
  Layer.provide(EnvProviderLayer)
);

const HttpLive = HttpApiBuilder.serve().pipe(
  Layer.provide(MainApiLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
);

NodeRuntime.runMain(Layer.launch(HttpLive));


The migrations are executed the first time the server is executed.

Effect keeps track automatically of the current migration (as a table inside the database), so that migrations are applied only once.

Open Source Repository
Deriving type safe client
Since the API definition is separate, we can import it inside any client to derive a type safe service for HTTP requests.

For example, in your frontend app you can use HttpApiClient (from @effect/platform) to derive an HTTP client. We wrap it inside Effect.Service (to create a service):

Again, check out Effect: Beginners Complete Getting Started to learn more about services in effect

import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { Effect } from "effect";

import { ServerApi } from "@local/api"; // Shared API definition

export class ApiClient extends Effect.Service<ApiClient>()("ApiClient", {
  dependencies: [FetchHttpClient.layer], // Provide HTTP layer (`fetch`)
  effect: Effect.gen(function* () {
    const client = yield* HttpApiClient.make(ServerApi, {
      baseUrl: "http://localhost:3000",
    });

    return client;
  }),
}) {}


client allows executing type safe effects that perform HTTP requests, automatically handling building the request (method, payload, serialization, and more):

client provides type safe access to each group and API endpoint from the API definition.
