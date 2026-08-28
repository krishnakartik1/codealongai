import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const portableSpecifier = isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
  return nextResolve(portableSpecifier, context);
}
