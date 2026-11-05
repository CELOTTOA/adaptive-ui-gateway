import { appendFileSync } from "node:fs";
import { OperationBroker, SqliteInvocationStore } from "@aug/gateway-server";
import { principal, operation, invoke, control } from "../helpers/operation-fixtures.mjs";

const [database, marker] = process.argv.slice(2);
const broker = new OperationBroker({ store: new SqliteInvocationStore({ path: database, key: Buffer.from(process.env.AUG_TEST_STATE_KEY, "base64") }) });
broker.register({ operation: operation({ effect: "write", confirmation: "explicit" }), authorize: () => true,
  execute: () => {
    appendFileSync(marker, "applied\n");
    process.send({ state: "effect-applied", invocationId: pending.id });
    return new Promise(() => {});
  },
});
const pending = broker.invoke(principal, invoke());
broker.control(principal, control(pending, "confirm"));
process.on("message", () => {}); // Keep the owned test process alive until the parent kills it.
