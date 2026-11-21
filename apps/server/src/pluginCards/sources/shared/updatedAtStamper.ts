import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Timeline rows compare card id and `updatedAt`, so unchanged data must keep its time. */
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const makeUpdatedAtStamper = Effect.sync(() => {
  const seen = new Map<string, { readonly json: string; readonly at: string }>();
  return Effect.fn("PluginCards.stampUpdatedAt")(function* (key: string, data: unknown) {
    const json = encodeJson(data);
    const previous = seen.get(key);
    if (previous !== undefined && Option.isSome(json) && previous.json === json.value) {
      return previous.at;
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    if (Option.isSome(json)) seen.set(key, { json: json.value, at });
    else seen.delete(key);
    return at;
  });
});
