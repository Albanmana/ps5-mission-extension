export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pg') {
    return {
      shortCircuit: true,
      url: new URL('./failing-pg.mjs', import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
