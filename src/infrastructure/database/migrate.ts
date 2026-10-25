import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../../mikro-orm.config.js";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  throw new Error("Usage: bun run migration:{up|down}");
}

const orm = await MikroORM.init(config);
try {
  const migrator = orm.migrator;
  if (direction === "up") {
    await migrator.up();
  } else {
    await migrator.down();
  }
} finally {
  await orm.close(true);
}
