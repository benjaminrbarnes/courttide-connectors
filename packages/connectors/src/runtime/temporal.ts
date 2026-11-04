import { Temporal } from "@js-temporal/polyfill";
import { ConnectorError } from "../contract/errors.js";

export function parseLocalDate(value: string): Temporal.PlainDate {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error();
    const date = Temporal.PlainDate.from(value, { overflow: "reject" });
    if (date.toString() !== value) throw new Error();
    return date;
  } catch {
    throw new ConnectorError("unsupported_time");
  }
}

export function localDateTimeToInstant(
  value: string,
  timeZone: string,
): string {
  try {
    return Temporal.PlainDateTime.from(value, { overflow: "reject" })
      .toZonedDateTime(timeZone, { disambiguation: "reject" })
      .toInstant()
      .toString();
  } catch {
    throw new ConnectorError("unsupported_time");
  }
}
