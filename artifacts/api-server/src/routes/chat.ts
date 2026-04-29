import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  chatSessionsTable,
  chatMessagesTable,
  usersTable,
  studentsTable,
} from "@workspace/db";
import { eq, desc, and, or, gte, lte, sql, count, SQL, ilike, inArray } from "drizzle-orm";
import { requireAuth, requireApiKey, requireApiKeyOrAuth } from "../middlewares/auth";
import { matchIntent } from "../lib/intentMatcher";
import { askQwen } from "../lib/qwen";
import { retrieveContext, type UserContext } from "../lib/contextRetriever";

const router: IRouter = Router();

const askSchema = z.object({
  question: z.string().min(1, "Pertanyaan tidak boleh kosong").max(2000, "Pertanyaan terlalu panjang"),
  sessionId: z.string().uuid("Session ID tidak valid").optional(),
  deviceInfo: z.string().max(255).optional(),
});

const LOW_CONFIDENCE_THRESHOLD = 0.4;

router.post("/chat/ask", requireApiKeyOrAuth(), async (req: Request, res: Response) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { question, sessionId, deviceInfo } = parsed.data;

  try {
    let currentSessionId = sessionId;

    if (currentSessionId) {
      const [existing] = await db
        .select({ id: chatSessionsTable.id, userId: chatSessionsTable.userId })
        .from(chatSessionsTable)
        .where(eq(chatSessionsTable.id, currentSessionId));
      if (!existing) {
        currentSessionId = undefined;
      } else if (req.user?.userId && existing.userId && existing.userId !== req.user.userId) {
        currentSessionId = undefined;
      }
    }

    const resolvedDeviceInfo =
      deviceInfo ?? (req.headers["user-agent"] as string | undefined) ?? null;

    if (!currentSessionId) {
      const [newSession] = await db
        .insert(chatSessionsTable)
        .values({
          deviceInfo: resolvedDeviceInfo,
          userId: req.user?.userId ?? null,
        })
        .returning({ id: chatSessionsTable.id });
      currentSessionId = newSession.id;
    } else if (req.user?.userId) {
      await db
        .update(chatSessionsTable)
        .set({ userId: req.user.userId })
        .where(and(eq(chatSessionsTable.id, currentSessionId), sql`${chatSessionsTable.userId} IS NULL`));
    }

    const recentMessages = await db
      .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, currentSessionId))
      .orderBy(desc(chatMessagesTable.createdAt))
      .limit(6);

    const history = recentMessages
      .reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    let userCtx: UserContext | undefined;
    if (req.user?.userId) {
      const [studentRow] = await db
        .select({
          nim: studentsTable.nim,
          prodi: studentsTable.prodi,
          semester: studentsTable.semester,
          kelas: studentsTable.kelas,
          nama: usersTable.name,
        })
        .from(studentsTable)
        .leftJoin(usersTable, eq(usersTable.id, studentsTable.userId))
        .where(eq(studentsTable.userId, req.user.userId))
        .limit(1);
      if (studentRow) {
        userCtx = { nim: studentRow.nim, nama: studentRow.nama, prodi: studentRow.prodi, semester: studentRow.semester, kelas: studentRow.kelas };
      }
    }

    const intentResult = await matchIntent(question);

    let answer: string;
    let answerSource: "intent" | "ai" | "fallback";
    let confidence: number;

    if (intentResult.matched && intentResult.answer) {
      try {
        const qwenResult = await askQwen(question, history, undefined, intentResult.answer);
        answer = qwenResult.answer;
      } catch {
        answer = intentResult.answer;
      }
      answerSource = "intent";
      confidence = intentResult.confidence;
    } else {
      try {
        let dbContext = "";
        try {
          dbContext = await retrieveContext(question, userCtx);
        } catch (ctxErr) {
          req.log.error({ err: ctxErr }, "retrieveContext failed");
        }
        const qwenResult = await askQwen(question, history, dbContext || undefined);
        answer = qwenResult.answer;
        answerSource = "ai";
        confidence = dbContext ? 0.85 : 0.75;
      } catch (err) {
        req.log.error({ err }, "Qwen API error — using fallback");
        answer = "Maaf, layanan AI saat ini tidak tersedia. Silakan coba beberapa saat lagi atau hubungi bagian akademik UNPRA secara langsung.";
        answerSource = "fallback";
        confidence = 0;
      }
    }

    const needsReview = confidence < LOW_CONFIDENCE_THRESHOLD || answerSource === "fallback";

    await db.insert(chatMessagesTable).values([
      {
        sessionId: currentSessionId,
        role: "user",
        content: question,
        answerSource: null,
        confidence: null,
        needsReview: false,
      } as typeof chatMessagesTable.$inferInsert,
      {
        sessionId: currentSessionId,
        role: "assistant",
        content: answer,
        answerSource,
        confidence,
        needsReview,
      } as typeof chatMessagesTable.$inferInsert,
    ]);

    await db
      .update(chatSessionsTable)
      .set({ lastMessageAt: new Date() })
      .where(eq(chatSessionsTable.id, currentSessionId));

    res.json({
      answer,
      sessionId: currentSessionId,
      source: answerSource,
      confidence: Math.round(confidence * 100) / 100,
      needsReview,
    });
  } catch (err) {
    req.log.error({ err }, "Chat ask error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ------------------------------------------------------------------ */
/* USER-SCOPED endpoints — mahasiswa/dosen kelola riwayat chat sendiri */
/* ------------------------------------------------------------------ */

router.get("/chat/my-sessions", requireAuth(), async (req: Request, res: Response) => {
  const pageSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  });
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Parameter tidak valid", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const userId = req.user!.userId;
  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    const [sessions, totalRow] = await Promise.all([
      db
        .select({
          id: chatSessionsTable.id,
          deviceInfo: chatSessionsTable.deviceInfo,
          lastMessageAt: chatSessionsTable.lastMessageAt,
          createdAt: chatSessionsTable.createdAt,
          messageCount: count(chatMessagesTable.id),
          lastUserMessage: sql<string | null>`(
            SELECT cm.content FROM chat_messages cm
            WHERE cm.session_id = ${chatSessionsTable.id} AND cm.role = 'user'
            ORDER BY cm.created_at DESC LIMIT 1
          )`,
        })
        .from(chatSessionsTable)
        .leftJoin(chatMessagesTable, eq(chatMessagesTable.sessionId, chatSessionsTable.id))
        .where(eq(chatSessionsTable.userId, userId))
        .groupBy(chatSessionsTable.id)
        .orderBy(desc(chatSessionsTable.lastMessageAt))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(chatSessionsTable).where(eq(chatSessionsTable.userId, userId)),
    ]);

    res.json({
      sessions,
      pagination: {
        page,
        limit,
        total: totalRow[0]?.total ?? 0,
        totalPages: Math.ceil((totalRow[0]?.total ?? 0) / limit),
      },
    });
  } catch (err) {
    req.log.error({ err }, "List my-sessions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/chat/my-sessions/:id", requireAuth(), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const userId = req.user!.userId;

  try {
    const [session] = await db
      .select({
        id: chatSessionsTable.id,
        userId: chatSessionsTable.userId,
        deviceInfo: chatSessionsTable.deviceInfo,
        lastMessageAt: chatSessionsTable.lastMessageAt,
        createdAt: chatSessionsTable.createdAt,
      })
      .from(chatSessionsTable)
      .where(eq(chatSessionsTable.id, id))
      .limit(1);

    if (!session) {
      res.status(404).json({ error: "Sesi chat tidak ditemukan" });
      return;
    }
    if (session.userId !== userId) {
      res.status(403).json({ error: "Sesi chat ini bukan milik Anda" });
      return;
    }

    const messages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.sessionId, id))
      .orderBy(chatMessagesTable.createdAt);

    res.json({ session, messages });
  } catch (err) {
    req.log.error({ err }, "Get my-session detail error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/chat/my-sessions/:id", requireAuth(), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const userId = req.user!.userId;

  try {
    const [session] = await db
      .select({ id: chatSessionsTable.id, userId: chatSessionsTable.userId })
      .from(chatSessionsTable)
      .where(eq(chatSessionsTable.id, id))
      .limit(1);

    if (!session) {
      res.status(404).json({ error: "Sesi chat tidak ditemukan" });
      return;
    }
    if (session.userId !== userId) {
      res.status(403).json({ error: "Sesi chat ini bukan milik Anda" });
      return;
    }

    await db.delete(chatSessionsTable).where(eq(chatSessionsTable.id, id));
    res.json({ message: "Sesi chat berhasil dihapus" });
  } catch (err) {
    req.log.error({ err }, "Delete my-session error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/chat/my-sessions", requireAuth(), async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  try {
    const result = await db
      .delete(chatSessionsTable)
      .where(eq(chatSessionsTable.userId, userId))
      .returning({ id: chatSessionsTable.id });

    res.json({
      message: "Semua riwayat chat berhasil dihapus",
      deletedCount: result.length,
    });
  } catch (err) {
    req.log.error({ err }, "Delete all my-sessions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/chat/messages/:id", requireAuth(), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const userId = req.user!.userId;

  try {
    const [row] = await db
      .select({
        msgId: chatMessagesTable.id,
        sessionUserId: chatSessionsTable.userId,
      })
      .from(chatMessagesTable)
      .leftJoin(chatSessionsTable, eq(chatSessionsTable.id, chatMessagesTable.sessionId))
      .where(eq(chatMessagesTable.id, id))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Pesan tidak ditemukan" });
      return;
    }
    if (row.sessionUserId !== userId) {
      res.status(403).json({ error: "Pesan ini bukan milik Anda" });
      return;
    }

    await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, id));
    res.json({ message: "Pesan berhasil dihapus" });
  } catch (err) {
    req.log.error({ err }, "Delete message error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ------------------------------------------------------------------ */
/* ADMIN endpoints                                                     */
/* ------------------------------------------------------------------ */

router.get("/chat/sessions", requireAuth(["admin"]), async (req: Request, res: Response) => {
  const pageSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal harus YYYY-MM-DD")
      .optional(),
    search: z.string().optional(),
    userSearch: z.string().optional(),
    needsReview: z.coerce.boolean().optional(),
  });

  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Parameter tidak valid", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { page, limit, date, search, userSearch, needsReview } = parsed.data;
  const offset = (page - 1) * limit;

  try {
    const conditions: SQL[] = [];
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(gte(chatSessionsTable.createdAt, startOfDay));
      conditions.push(lte(chatSessionsTable.createdAt, endOfDay));
    }
    if (search) {
      conditions.push(ilike(chatSessionsTable.deviceInfo, `%${search}%`));
    }
    if (needsReview) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.session_id = ${chatSessionsTable.id} AND cm.needs_review = true)`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [sessions, totalResult] = await Promise.all([
      db
        .select({
          id: chatSessionsTable.id,
          userId: chatSessionsTable.userId,
          deviceInfo: chatSessionsTable.deviceInfo,
          lastMessageAt: chatSessionsTable.lastMessageAt,
          createdAt: chatSessionsTable.createdAt,
          messageCount: count(chatMessagesTable.id),
          reviewCount: sql<number>`cast(count(case when ${chatMessagesTable.needsReview} = true then 1 end) as integer)`,
          userName: usersTable.name,
          userEmail: usersTable.email,
        })
        .from(chatSessionsTable)
        .leftJoin(chatMessagesTable, eq(chatMessagesTable.sessionId, chatSessionsTable.id))
        .leftJoin(usersTable, eq(usersTable.id, chatSessionsTable.userId))
        .where(
          userSearch
            ? and(whereClause, or(
                ilike(usersTable.name, `%${userSearch}%`),
                ilike(usersTable.email, `%${userSearch}%`),
              ))
            : whereClause
        )
        .groupBy(chatSessionsTable.id, usersTable.name, usersTable.email)
        .orderBy(desc(chatSessionsTable.lastMessageAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(chatSessionsTable)
        .leftJoin(usersTable, eq(usersTable.id, chatSessionsTable.userId))
        .where(
          userSearch
            ? and(whereClause, or(
                ilike(usersTable.name, `%${userSearch}%`),
                ilike(usersTable.email, `%${userSearch}%`),
              ))
            : whereClause
        ),
    ]);

    res.json({
      sessions,
      pagination: {
        page,
        limit,
        total: totalResult[0]?.total ?? 0,
        totalPages: Math.ceil((totalResult[0]?.total ?? 0) / limit),
      },
    });
  } catch (err) {
    req.log.error({ err }, "List sessions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/chat/sessions/bulk-delete", requireAuth(["admin"]), async (req: Request, res: Response) => {
  const schema = z
    .object({
      ids: z.array(z.string().uuid()).optional(),
      olderThanDays: z.coerce.number().int().min(1).optional(),
    })
    .refine(
      (v) => (v.ids && v.ids.length > 0) || typeof v.olderThanDays === "number",
      { message: "Harus menyertakan 'ids' (array) atau 'olderThanDays' (>=1)" },
    );

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", details: parsed.error.flatten() });
    return;
  }

  const { ids, olderThanDays } = parsed.data;

  try {
    const conditions: SQL[] = [];
    if (ids && ids.length > 0) {
      conditions.push(inArray(chatSessionsTable.id, ids));
    }
    if (typeof olderThanDays === "number") {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      conditions.push(lte(chatSessionsTable.lastMessageAt, cutoff));
    }

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    const result = await db
      .delete(chatSessionsTable)
      .where(whereClause!)
      .returning({ id: chatSessionsTable.id });

    res.json({
      message: `Berhasil menghapus ${result.length} sesi chat`,
      deletedCount: result.length,
    });
  } catch (err) {
    req.log.error({ err }, "Bulk delete sessions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/chat/sessions/:id", requireAuth(["admin"]), async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const [sessionRow, messages] = await Promise.all([
      db
        .select({
          id: chatSessionsTable.id,
          userId: chatSessionsTable.userId,
          deviceInfo: chatSessionsTable.deviceInfo,
          lastMessageAt: chatSessionsTable.lastMessageAt,
          createdAt: chatSessionsTable.createdAt,
          messageCount: count(chatMessagesTable.id),
        })
        .from(chatSessionsTable)
        .leftJoin(chatMessagesTable, eq(chatMessagesTable.sessionId, chatSessionsTable.id))
        .where(eq(chatSessionsTable.id, id))
        .groupBy(chatSessionsTable.id),
      db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.sessionId, id))
        .orderBy(chatMessagesTable.createdAt),
    ]);

    const session = sessionRow[0];
    if (!session) {
      res.status(404).json({ error: "Session tidak ditemukan" });
      return;
    }

    res.json({ session, messages });
  } catch (err) {
    req.log.error({ err }, "Get session detail error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/chat/sessions/:id", requireAuth(["admin"]), async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const result = await db
      .delete(chatSessionsTable)
      .where(eq(chatSessionsTable.id, id))
      .returning({ id: chatSessionsTable.id });

    if (result.length === 0) {
      res.status(404).json({ error: "Session tidak ditemukan" });
      return;
    }

    res.json({ message: "Sesi chat berhasil dihapus" });
  } catch (err) {
    req.log.error({ err }, "Delete session (admin) error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/chat/messages/:id/report", requireApiKeyOrAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const schema = z.object({ reason: z.string().max(500).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", details: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const [msg] = await db
      .select({ id: chatMessagesTable.id, role: chatMessagesTable.role })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.id, id))
      .limit(1);

    if (!msg) {
      res.status(404).json({ error: "Pesan tidak ditemukan" });
      return;
    }
    if (msg.role !== "assistant") {
      res.status(400).json({ error: "Hanya pesan dari AI yang bisa dilaporkan" });
      return;
    }

    await db
      .update(chatMessagesTable)
      .set({ needsReview: true, reportReason: parsed.data.reason ?? null })
      .where(eq(chatMessagesTable.id, id));

    res.json({ message: "Laporan berhasil dikirim. Terima kasih atas masukanmu!" });
  } catch (err) {
    req.log.error({ err }, "Report message error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/chat/messages/:id/flag", requireAuth(["admin"]), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const schema = z.object({ needsReview: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data tidak valid", details: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    await db
      .update(chatMessagesTable)
      .set({ needsReview: parsed.data.needsReview })
      .where(eq(chatMessagesTable.id, id));
    res.json({ message: "Status review berhasil diperbarui" });
  } catch (err) {
    req.log.error({ err }, "Flag message error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/chat/stats", requireAuth(["admin"]), async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());

    const sevenDaysAgo = new Date(startOfToday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    const [
      todaySessions,
      weekSessions,
      todayMessages,
      needsReviewCount,
      sourceBreakdown,
      lowConfidenceSessions,
      popularTopicsWeek,
      dailyBreakdown,
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(chatSessionsTable)
        .where(gte(chatSessionsTable.createdAt, startOfToday)),
      db
        .select({ count: count() })
        .from(chatSessionsTable)
        .where(gte(chatSessionsTable.createdAt, startOfWeek)),
      db
        .select({ count: count() })
        .from(chatMessagesTable)
        .where(and(gte(chatMessagesTable.createdAt, startOfToday), eq(chatMessagesTable.role, "user"))),
      db
        .select({ count: count() })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.needsReview, true)),
      db
        .select({
          source: chatMessagesTable.answerSource,
          count: count(),
        })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.role, "assistant"))
        .groupBy(chatMessagesTable.answerSource),
      db
        .select({
          sessionId: chatMessagesTable.sessionId,
          avgConfidence: sql<number>`AVG(${chatMessagesTable.confidence})`,
        })
        .from(chatMessagesTable)
        .where(
          and(
            eq(chatMessagesTable.role, "assistant"),
            gte(chatMessagesTable.createdAt, startOfWeek)
          )
        )
        .groupBy(chatMessagesTable.sessionId)
        .having(sql`AVG(${chatMessagesTable.confidence}) < ${LOW_CONFIDENCE_THRESHOLD}`)
        .limit(10),
      db
        .select({
          content: chatMessagesTable.content,
          count: count(),
        })
        .from(chatMessagesTable)
        .where(
          and(
            eq(chatMessagesTable.role, "user"),
            gte(chatMessagesTable.createdAt, startOfWeek)
          )
        )
        .groupBy(chatMessagesTable.content)
        .orderBy(desc(count()))
        .limit(10),
      db
        .select({
          day: sql<string>`DATE(${chatSessionsTable.createdAt})`,
          count: count(),
        })
        .from(chatSessionsTable)
        .where(gte(chatSessionsTable.createdAt, sevenDaysAgo))
        .groupBy(sql`DATE(${chatSessionsTable.createdAt})`)
        .orderBy(sql`DATE(${chatSessionsTable.createdAt})`),
    ]);

    const dailyTrendMap: Record<string, number> = {};
    for (const row of dailyBreakdown) {
      if (row.day) dailyTrendMap[row.day] = row.count;
    }
    const dailyTrend = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      return { date: key, sessions: dailyTrendMap[key] ?? 0 };
    });

    res.json({
      today: {
        sessions: todaySessions[0]?.count ?? 0,
        messages: todayMessages[0]?.count ?? 0,
      },
      week: {
        sessions: weekSessions[0]?.count ?? 0,
      },
      needsReview: needsReviewCount[0]?.count ?? 0,
      dailyTrend,
      sourceBreakdown: sourceBreakdown.reduce(
        (acc, row) => {
          if (row.source) acc[row.source] = row.count;
          return acc;
        },
        {} as Record<string, number>
      ),
      popularTopics: popularTopicsWeek.map((row) => ({
        question: row.content,
        count: row.count,
      })),
      lowConfidenceSessions: lowConfidenceSessions.map((s) => ({
        sessionId: s.sessionId,
        avgConfidence: Math.round((s.avgConfidence ?? 0) * 100) / 100,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Stats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
