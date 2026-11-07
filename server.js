if (typeof Bun === "undefined") {
  throw new Error("Este projeto deve ser executado com Bun.");
}

await import("./src/server.ts");
