import { AdmissionError } from "../runtime/admission-protocol.js";
import { createHttpAdmissionGate } from "../runtime/http-admission.js";
import type { ReadExecution } from "./read.js";
import type { CliIO } from "./types.js";

/** Resolve once per invocation, so each read uses the same local and remote gate. */
export function prepareAdmission(execution: ReadExecution, io: CliIO) {
  if (execution.admission !== undefined) return execution.admission;
  const env = io.env ?? process.env;
  const values = [
    env.CONNECTORS_ADMISSION_RESERVE_URL,
    env.CONNECTORS_ADMISSION_OUTCOME_URL,
    env.CONNECTORS_ADMISSION_SOURCE_ORIGIN,
    env.CONNECTORS_ADMISSION_BEARER,
  ];
  if (values.every((value) => value === undefined)) {
    execution.admission = null;
    return null;
  }
  if (values.some((value) => typeof value !== "string" || !value))
    throw new AdmissionError("unavailable");
  const [reserveUrl, outcomeUrlTemplate, sourceOrigin, bearer] = values as [
    string,
    string,
    string,
    string,
  ];
  const gate = createHttpAdmissionGate({
    reserveUrl,
    outcomeUrlTemplate,
    sourceOrigin,
    bearer,
    localGate: execution.gate,
    serviceFetch: io.admissionFetch,
    signal: io.signal,
  });
  execution.admission = { gate, sourceOrigin: new URL(sourceOrigin).origin };
  return execution.admission;
}
