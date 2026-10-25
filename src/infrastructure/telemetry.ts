import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export const telemetrySdk = endpoint
  ? new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "distributed-wagering-processor",
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
          exportIntervalMillis: 10_000,
        }),
      ],
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    })
  : undefined;

telemetrySdk?.start();
