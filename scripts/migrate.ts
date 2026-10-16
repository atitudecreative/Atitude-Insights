import { runMigrations } from "../src/server/db/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}
runMigrations(url)
  .then(() => console.log("Migrações concluídas."))
  .catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
