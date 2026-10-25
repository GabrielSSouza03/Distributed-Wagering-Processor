import { Module } from "@nestjs/common";
import {
  CLOCK,
  ID_GENERATOR,
  SystemClock,
  UuidGenerator,
  type Clock,
  type IdGenerator,
} from "../shared/application/system.port.js";
import { SqsService } from "../infrastructure/sqs/sqs.service.js";
import { CreateWallet } from "./wallet/application/create-wallet.js";
import { WalletController } from "./wallet/interface/wallet.controller.js";
import {
  FINANCIAL_STORE,
  type FinancialStore,
} from "./wagering/application/financial-store.port.js";
import { ProcessWagerTransaction } from "./wagering/application/process-wager-transaction.js";
import { ReprocessPendingReference } from "./wagering/application/reprocess-pending-reference.js";
import { MikroFinancialStore } from "./wagering/infrastructure/mikro-financial.store.js";
import { WageringController } from "./wagering/interface/wagering.controller.js";
import { OutboxPublisher } from "./messaging/infrastructure/outbox.publisher.js";
import { WagerConsumer } from "./messaging/infrastructure/wager.consumer.js";
import { PendingReferenceWorker } from "./messaging/infrastructure/pending-reference.worker.js";

@Module({
  controllers: [WalletController, WageringController],
  providers: [
    SqsService,
    MikroFinancialStore,
    { provide: FINANCIAL_STORE, useExisting: MikroFinancialStore },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidGenerator },
    {
      provide: CreateWallet,
      inject: [FINANCIAL_STORE, CLOCK, ID_GENERATOR],
      useFactory: (store: FinancialStore, clock: Clock, ids: IdGenerator) =>
        new CreateWallet(store, clock, ids),
    },
    {
      provide: ProcessWagerTransaction,
      inject: [FINANCIAL_STORE, CLOCK, ID_GENERATOR],
      useFactory: (store: FinancialStore, clock: Clock, ids: IdGenerator) =>
        new ProcessWagerTransaction(store, clock, ids),
    },
    {
      provide: ReprocessPendingReference,
      inject: [FINANCIAL_STORE, CLOCK, ID_GENERATOR],
      useFactory: (store: FinancialStore, clock: Clock, ids: IdGenerator) =>
        new ReprocessPendingReference(store, clock, ids),
    },
    OutboxPublisher,
    WagerConsumer,
    PendingReferenceWorker,
  ],
  exports: [ProcessWagerTransaction, SqsService],
})
export class FinancialModule {}
