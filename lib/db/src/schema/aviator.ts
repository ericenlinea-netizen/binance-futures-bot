import { pgTable, serial, real, timestamp, integer, pgEnum, smallint } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const signalTypeEnum = pgEnum("signal_type", ["ENTER", "WAIT"]);

// WIN    = won (gale_attempt=0 → Ganada directa, gale_attempt=1 → Ganada con Gale)
// LOSS   = lost (gale_attempt=0 → gale triggered internally, gale_attempt=1 → Perdida total)
// PENDING = waiting for next round result
export const outcomeEnum = pgEnum("outcome", ["WIN", "LOSS", "PENDING"]);

export const gameRoundsTable = pgTable("game_rounds", {
  id: serial("id").primaryKey(),
  multiplier: real("multiplier").notNull(),
  crashedAt: timestamp("crashed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const signalLogsTable = pgTable("signal_logs", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id").references(() => gameRoundsTable.id),
  signalType: signalTypeEnum("signal_type").notNull(),
  confidence: real("confidence").notNull(),
  outcome: outcomeEnum("outcome").notNull().default("PENDING"),
  // 0 = first entry attempt, 1 = gale (second) attempt
  galeAttempt: smallint("gale_attempt").notNull().default(0),
  // Multiplier target this signal was evaluated against (1.5 or 2.0)
  hitTarget: real("hit_target").notNull().default(1.5),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRoundSchema = createInsertSchema(gameRoundsTable, {
  multiplier: z.number().min(1.0).max(1000),
}).omit({ id: true, createdAt: true });

export const insertSignalSchema = createInsertSchema(signalLogsTable).omit({ id: true, createdAt: true });
export const selectRoundSchema = createSelectSchema(gameRoundsTable);
export const selectSignalSchema = createSelectSchema(signalLogsTable);

export type InsertRound = z.infer<typeof insertRoundSchema>;
export type Round = typeof gameRoundsTable.$inferSelect;
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signalLogsTable.$inferSelect;
