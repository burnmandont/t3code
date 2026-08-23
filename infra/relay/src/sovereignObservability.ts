import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

export interface SovereignObservabilityConfiguration {
  readonly tracesUrl: string | undefined;
  readonly metricsUrl: string | undefined;
  readonly authorization: Redacted.Redacted<string> | undefined;
}

export const makeSovereignObservabilityLayer = (config: SovereignObservabilityConfiguration) => {
  const headers =
    config.authorization === undefined
      ? undefined
      : { Authorization: Redacted.value(config.authorization) };
  const resource = {
    serviceName: "t3-sovereign-relay",
    attributes: {
      "service.runtime": "node",
      "service.component": "relay",
      "deployment.environment.name": "production",
    },
  };
  const traces =
    config.tracesUrl === undefined
      ? Layer.empty
      : OtlpTracer.layer({
          url: config.tracesUrl,
          headers,
          resource,
          exportInterval: "5 seconds",
        });
  const metrics =
    config.metricsUrl === undefined
      ? Layer.empty
      : OtlpMetrics.layer({
          url: config.metricsUrl,
          headers,
          resource,
          exportInterval: "10 seconds",
        });

  return Layer.merge(traces, metrics).pipe(Layer.provideMerge(OtlpSerialization.layerJson));
};
