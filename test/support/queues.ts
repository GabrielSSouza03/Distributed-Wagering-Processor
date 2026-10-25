import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";

export const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";

export const sqs = new SQSClient({
  endpoint: AWS_ENDPOINT_URL,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

export interface IsolatedQueues {
  inputUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

async function createFifo(name: string, attributes: Record<string, string> = {}): Promise<string> {
  const output = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        ...attributes,
      },
    }),
  );
  if (!output.QueueUrl) throw new Error(`Queue URL missing for ${name}`);
  return output.QueueUrl;
}

/** Per-test queues, so no scenario consumes another scenario's messages. */
export async function createIsolatedQueues(prefix: string): Promise<IsolatedQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const dlqUrl = await createFifo(`${prefix}-dlq-${suffix}.fifo`);
  const inputUrl = await createFifo(`${prefix}-input-${suffix}.fifo`);
  const eventsUrl = await createFifo(`${prefix}-events-${suffix}.fifo`);
  return { inputUrl, dlqUrl, eventsUrl };
}

export function queueEnvironment(queues: IsolatedQueues): Record<string, string> {
  return {
    WAGER_QUEUE_URL: queues.inputUrl,
    WAGER_DLQ_URL: queues.dlqUrl,
    EVENTS_QUEUE_URL: queues.eventsUrl,
  };
}

export async function sendJson(
  queueUrl: string,
  body: unknown,
  groupId: string,
  deduplicationId: string = crypto.randomUUID(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function queueDepth(queueUrl: string): Promise<number> {
  const output = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  const visible = Number.parseInt(output.Attributes?.ApproximateNumberOfMessages ?? "0", 10);
  const inFlight = Number.parseInt(
    output.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0",
    10,
  );
  return visible + inFlight;
}

/** Reads and deletes every message currently available in the queue. */
export async function drain(queueUrl: string, idleRounds = 3): Promise<Message[]> {
  const messages: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const output = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    const batch = output.Messages ?? [];
    if (batch.length === 0) {
      idle += 1;
      continue;
    }
    idle = 0;
    for (const message of batch) {
      messages.push(message);
      if (message.ReceiptHandle) {
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
  }
  return messages;
}

export interface DeadLetter {
  originalBody: string;
  failureCode: string;
  detail: string;
}

/** Polls the DLQ until a dead letter for the given original message id appears. */
export async function waitForDeadLetter(
  dlqUrl: string,
  originalMessageId: string,
  timeoutMs = 30_000,
): Promise<DeadLetter> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const message of await drain(dlqUrl, 1)) {
      const letter = JSON.parse(message.Body ?? "{}") as DeadLetter;
      if (letter.originalBody.includes(originalMessageId)) return letter;
    }
  }
  throw new Error(`No dead letter for ${originalMessageId}`);
}

export function wagerMessage(
  data: Record<string, unknown>,
  messageId = `msg-${crypto.randomUUID()}`,
): { messageId: string; type: string; occurredAt: string; data: Record<string, unknown> } {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}
