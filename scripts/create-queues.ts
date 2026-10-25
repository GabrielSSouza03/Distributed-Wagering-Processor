import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

const client = new SQSClient({
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
  },
});

async function createFifoQueue(
  name: string,
  additionalAttributes: Record<string, string> = {},
): Promise<string> {
  const response = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        ReceiveMessageWaitTimeSeconds: "2",
        ...additionalAttributes,
      },
    }),
  );
  if (!response.QueueUrl) throw new Error(`MiniStack did not return the URL for ${name}`);
  return response.QueueUrl;
}

const dlqUrl = await createFifoQueue("wager-transactions-dlq.fifo");
const dlqAttributes = await client.send(
  new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
);
const dlqArn = dlqAttributes.Attributes?.QueueArn;
if (!dlqArn) throw new Error("MiniStack did not return the DLQ ARN");

const inputUrl = await createFifoQueue("wager-transactions.fifo", {
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
});
const eventsUrl = await createFifoQueue("wagering-events.fifo");

console.log(JSON.stringify({ inputUrl, dlqUrl, eventsUrl }));
client.destroy();
