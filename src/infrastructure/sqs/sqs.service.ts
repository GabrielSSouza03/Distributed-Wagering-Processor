import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { Injectable, OnModuleDestroy } from "@nestjs/common";

@Injectable()
export class SqsService implements OnModuleDestroy {
  readonly client = new SQSClient({
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
    },
  });

  async ensureQueue(name: string): Promise<string> {
    try {
      const found = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      if (found.QueueUrl) return found.QueueUrl;
    } catch {
      // Development convenience only; production provisioning stays outside the app.
    }
    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: name.endsWith(".fifo") ? { FifoQueue: "true" } : undefined,
      }),
    );
    if (!created.QueueUrl) throw new Error(`Unable to resolve SQS queue ${name}`);
    return created.QueueUrl;
  }

  async send(
    queueUrl: string,
    body: string,
    groupId: string,
    deduplicationId: string,
    traceparent?: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: traceparent
          ? { traceparent: { DataType: "String", StringValue: traceparent } }
          : undefined,
      }),
    );
  }

  async receive(queueUrl: string, signal?: AbortSignal): Promise<Message[]> {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 30,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      MessageAttributeNames: ["All"],
    });
    const result = signal
      ? await this.client.send(command, { abortSignal: signal })
      : await this.client.send(command);
    return result.Messages ?? [];
  }

  async acknowledge(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(
    queueUrl: string,
    receiptHandle: string,
    timeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
