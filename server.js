const pg = require("pg");
const { ApolloServer, gql } = require("apollo-server");
const {
  createPostGraphileSchema,
  withPostGraphileContext
} = require("postgraphile");

// Not used in this, but available for typings.
// import { ApolloServerPlugin, GraphQLRequestListener } from "apollo-server-plugin-base";

const postGraphileOptions = {
  jwtSecret: process.env.JWT_SECRET || String(Math.random())
};

async function main() {
  const dbSchema = process.env.SCHEMA_NAMES
    ? process.env.SCHEMA_NAMES.split(",")
    : "public";
  const pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });
  // See https://www.graphile.org/postgraphile/usage-schema/ for schema-only usage guidance
  const graphqlSchema = await createPostGraphileSchema(
    pgPool,
    dbSchema,
    postGraphileOptions
  );
  const { pgSettings: pgSettingsGenerator } = postGraphileOptions;

  const server = new ApolloServer({
    schema: graphqlSchema,
    plugins: [
      {
        requestDidStart() {
          /*
           * PostGraphile requires an authenticated pgClient to be on `context`
           * when it runs, and for that client to be released back to the pool
           * when the request completes/fails. In PostGraphile we wrap the
           * GraphQL query with `withPostGraphileContext to ensure that this is
           * handled.
           *
           * Apollo Server has a `context` callback which can be used
           * to generate the context, but unfortunately it does not have a
           * `releaseContext` method to clear up the context once the request
           * is done. We cannot provision the pgClient in `context` itself (as
           * would be cleanest) because certain error conditions within Apollo
           * Server would mean that we never get a chance to release it.
           *
           * Instead we must use the lifecycle-hooks functionality in the
           * latest Apollo Server to write to the context when the request
           * starts, and clear the context when the result (success or error)
           * will be sent.
           */

          let finished;
          return {
            /*
             * Since `requestDidStart` itself is synchronous, we must hijack an
             * asynchronous callback in order to set up our context.
             */
            async didResolveOperation(requestContext) {
              const {
                context: graphqlContext,
                request: graphqlRequest
              } = requestContext;

              /*
               * Get access to the original HTTP request to determine the JWT
               * and also perform anything needed for pgSettings support.
               * (Actually this is a subset of the original HTTP request
               * according to the Apollo Server typings, it only contains
               * "headers"?)
               */
              const { http: req } = graphqlRequest;

              // Extract the JWT if present:
              const authorizationBearerRex = /^\s*bearer\s+([a-z0-9\-._~+/]+=*)\s*$/i;
              const matches =
                req &&
                req.headers &&
                req.headers.authorization &&
                req.headers.authorization.match(authorizationBearerRex);
              const jwtToken = matches ? matches[1] : null;

              // Perform the `pgSettings` callback, if appropriate
              const pgSettings =
                typeof pgSettingsGenerator === "function"
                  ? await pgSettingsGenerator(req)
                  : pgSettingsGenerator;

              // Finally add our required properties to the context
              await new Promise((resolve, reject) => {
                withPostGraphileContext(
                  {
                    ...postGraphileOptions,
                    pgSettings,
                    pgPool,
                    jwtToken
                  },
                  context => {
                    return new Promise(releaseContext => {
                      // Jesse, an Apollo Server developer, told me to do this 😜
                      Object.assign(graphqlContext, context);

                      /*
                       * Don't resolve (don't release the pgClient on context) until
                       * the request is complete.
                       */
                      finished = releaseContext;

                      // The context is now ready to be used.
                      resolve();
                    });
                  }
                ).catch(e => {
                  console.error("Error occurred creating context!");
                  console.error(e);
                  // Release context
                  if (finished) {
                    finished();
                    finished = null;
                  }

                  reject(e);
                });
              });
            },
            willSendResponse(context) {
              // Release the context;
              if (typeof finished === 'function') {
                finished();
              }
            }
          };
        }
      }
    ]
  });

  server.listen().then(({ url }) => {
    console.log(`🚀 Server ready at ${url}`);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
