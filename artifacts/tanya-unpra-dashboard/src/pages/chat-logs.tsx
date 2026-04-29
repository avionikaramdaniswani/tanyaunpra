import { useState } from "react";
import { format } from "date-fns";
import {
  useListChatSessions,
  useGetChatSession,
  useGetChatStats,
  useFlagChatMessage,
  useDeleteChatSession,
  useBulkDeleteChatSessions,
  getListChatSessionsQueryKey,
  getGetChatSessionQueryKey,
  getGetChatStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, MessageSquare, AlertTriangle, CheckCircle, Search, Calendar as CalendarIcon, ChevronLeft, ChevronRight, Trash2, CheckSquare, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ListSessionsCache = {
  sessions: Array<{ id: string }>;
  pagination?: { total: number; page: number; limit: number; totalPages: number };
} | undefined;

export default function ChatLogs() {
  const [page, setPage] = useState(1);
  const [date, setDate] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [userSearch, setUserSearch] = useState<string>("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState<string>("30");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: stats } = useGetChatStats();
  const sessionsQueryParams = {
    page,
    limit: 10,
    date: date || undefined,
    search: search || undefined,
    userSearch: userSearch || undefined,
    needsReview: flaggedOnly || undefined,
  };
  const { data: sessionsData, isLoading, isError } = useListChatSessions(sessionsQueryParams);

  const removeSessionsFromCache = (ids: string[]) => {
    const idSet = new Set(ids);
    queryClient.setQueriesData<ListSessionsCache>({ queryKey: ["listChatSessions"] }, (old) => {
      if (!old) return old;
      const filtered = old.sessions.filter((s) => !idSet.has(s.id));
      const removed = old.sessions.length - filtered.length;
      return {
        ...old,
        sessions: filtered,
        pagination: old.pagination
          ? {
              ...old.pagination,
              total: Math.max(0, old.pagination.total - removed),
              totalPages: Math.max(
                1,
                Math.ceil(Math.max(0, old.pagination.total - removed) / old.pagination.limit),
              ),
            }
          : old.pagination,
      };
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  };

  const refetchInBackground = () => {
    queryClient.invalidateQueries({ queryKey: ["listChatSessions"] });
    queryClient.invalidateQueries({ queryKey: getGetChatStatsQueryKey() });
  };

  const deleteSessionMutation = useDeleteChatSession({
    mutation: {
      onSuccess: (_data, variables) => {
        const id = variables.id;
        removeSessionsFromCache([id]);
        refetchInBackground();
        toast({ title: "Sesi dihapus", description: "Sesi chat dan semua pesannya berhasil dihapus." });
        setDeleteSessionId(null);
        if (selectedSessionId === id) setSelectedSessionId(null);
      },
      onError: () => {
        toast({ title: "Gagal menghapus", description: "Tidak bisa menghapus sesi. Coba lagi.", variant: "destructive" });
      },
    },
  });

  const bulkDeleteMutation = useBulkDeleteChatSessions({
    mutation: {
      onSuccess: (data, variables) => {
        const idsSent = variables.data?.ids;
        if (idsSent && idsSent.length > 0) {
          removeSessionsFromCache(idsSent);
        } else {
          // cleanup-by-age — server figured out which rows; safer to just refetch
          queryClient.invalidateQueries({ queryKey: ["listChatSessions"] });
        }
        queryClient.invalidateQueries({ queryKey: getGetChatStatsQueryKey() });
        if (!idsSent || idsSent.length === 0) refetchInBackground();
        toast({
          title: idsSent ? "Sesi terpilih dihapus" : "Cleanup selesai",
          description: `${data.deletedCount} sesi chat berhasil dihapus.`,
        });
        setCleanupOpen(false);
        setConfirmBulkOpen(false);
        if (idsSent && idsSent.length > 0) {
          setSelectMode(false);
        }
      },
      onError: () => {
        toast({ title: "Gagal menghapus", description: "Tidak bisa menghapus sesi. Coba lagi.", variant: "destructive" });
      },
    },
  });

  const visibleSessions = sessionsData?.sessions ?? [];
  const allVisibleIds = visibleSessions.map((s) => s.id);
  const allVisibleSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = allVisibleIds.some((id) => selectedIds.has(id));

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of allVisibleIds) next.delete(id);
      } else {
        for (const id of allVisibleIds) next.add(id);
      }
      return next;
    });
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Chat Logs</h1>
          <p className="text-muted-foreground">Monitor and review AI interactions from the mobile app.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectMode ? (
            <>
              <span className="text-sm text-muted-foreground">
                {selectedIds.size} sesi terpilih
              </span>
              <Button
                variant="destructive"
                disabled={selectedIds.size === 0 || bulkDeleteMutation.isPending}
                onClick={() => setConfirmBulkOpen(true)}
                data-testid="button-bulk-delete-selected"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Hapus Terpilih
              </Button>
              <Button variant="ghost" onClick={exitSelectMode} data-testid="button-exit-select-mode">
                <X className="h-4 w-4 mr-2" />
                Batal
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setSelectMode(true)} data-testid="button-enter-select-mode">
                <CheckSquare className="h-4 w-4 mr-2" />
                Mode Pilih
              </Button>
              <Button variant="outline" onClick={() => setCleanupOpen(true)} data-testid="button-cleanup-sessions">
                <Trash2 className="h-4 w-4 mr-2" />
                Hapus Sesi Lama
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sessions Today</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.today.sessions || 0}</div>
            <p className="text-xs text-muted-foreground">{stats?.today.messages || 0} messages today</p>
          </CardContent>
        </Card>
        <Card
          className={`cursor-pointer transition-colors ${flaggedOnly ? "border-destructive bg-destructive/5" : "hover:border-destructive/50"}`}
          onClick={() => { setFlaggedOnly(f => !f); setPage(1); }}
          title="Klik untuk filter sesi yang perlu review"
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Needs Review</CardTitle>
            <AlertTriangle className={`h-4 w-4 ${flaggedOnly ? "text-destructive" : "text-destructive"}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{stats?.needsReview || 0}</div>
            <p className="text-xs text-muted-foreground">
              {flaggedOnly ? "Menampilkan sesi bermasalah ✓" : "Klik untuk filter sesi bermasalah"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sessions This Week</CardTitle>
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.week.sessions || 0}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Chat Sessions</CardTitle>
          <CardDescription>Recent chat sessions from users</CardDescription>
        </CardHeader>
        <CardContent>
          {isError && (
            <div className="mb-4 rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              Gagal memuat data sesi chat. Periksa koneksi atau coba lagi.
            </div>
          )}
          <div className="flex flex-col md:flex-row flex-wrap gap-3 mb-6">
            <div className="relative">
              <CalendarIcon className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="date"
                value={date}
                onChange={(e) => { setDate(e.target.value); setPage(1); }}
                className="pl-9 w-full md:max-w-xs"
              />
            </div>
            <div className="relative flex-1 md:max-w-xs">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Cari nama/email pengguna..."
                value={userSearch}
                onChange={(e) => { setUserSearch(e.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>
            <div className="relative flex-1 md:max-w-xs">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Cari device info..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>
            {(date || search || userSearch) && (
              <Button variant="ghost" onClick={() => { setDate(""); setSearch(""); setUserSearch(""); setPage(1); }}>
                Hapus Filter
              </Button>
            )}
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {selectMode && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                        onCheckedChange={toggleSelectAllVisible}
                        aria-label="Pilih semua di halaman ini"
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                  )}
                  <TableHead>Time</TableHead>
                  <TableHead>Device / User</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Review</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={selectMode ? 6 : 5} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                    </TableCell>
                  </TableRow>
                ) : sessionsData?.sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={selectMode ? 6 : 5} className="h-24 text-center text-muted-foreground">
                      {flaggedOnly ? "Tidak ada sesi dengan pesan yang perlu review." : "No chat sessions found."}
                    </TableCell>
                  </TableRow>
                ) : (
                  sessionsData?.sessions.map((session) => (
                    <TableRow
                      key={session.id}
                      className={`${session.reviewCount > 0 ? "bg-destructive/5" : ""} ${selectedIds.has(session.id) ? "bg-primary/5" : ""}`}
                    >
                      {selectMode && (
                        <TableCell className="w-10">
                          <Checkbox
                            checked={selectedIds.has(session.id)}
                            onCheckedChange={() => toggleSelectOne(session.id)}
                            aria-label="Pilih sesi"
                            data-testid={`checkbox-session-${session.id}`}
                          />
                        </TableCell>
                      )}
                      <TableCell className="font-medium whitespace-nowrap">
                        {format(new Date(session.lastMessageAt), "dd MMM yyyy, HH:mm")}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">
                            {session.userName || (session.userId ? `ID: ${session.userId.slice(0, 8)}…` : "Anonim")}
                          </span>
                          {session.userEmail && (
                            <span className="text-xs text-muted-foreground">{session.userEmail}</span>
                          )}
                          <span className="text-xs text-muted-foreground">{session.deviceInfo || "Perangkat tidak diketahui"}</span>
                        </div>
                      </TableCell>
                      <TableCell>{session.messageCount}</TableCell>
                      <TableCell>
                        {session.reviewCount > 0 ? (
                          <Badge variant="destructive" className="gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {session.reviewCount}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" onClick={() => setSelectedSessionId(session.id)}>
                            View Details
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteSessionId(session.id)}
                            title="Hapus sesi chat ini"
                            data-testid={`button-delete-session-${session.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {sessionsData?.pagination && sessionsData.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between space-x-2 py-4">
              <span className="text-sm text-muted-foreground">
                Page {sessionsData.pagination.page} of {sessionsData.pagination.totalPages}
              </span>
              <div className="flex space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(sessionsData.pagination.totalPages, p + 1))}
                  disabled={page === sessionsData.pagination.totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedSessionId && (
        <ChatSessionDetailModal
          sessionId={selectedSessionId}
          onClose={() => setSelectedSessionId(null)}
          onDelete={() => setDeleteSessionId(selectedSessionId)}
        />
      )}

      <AlertDialog open={confirmBulkOpen} onOpenChange={(open) => !bulkDeleteMutation.isPending && setConfirmBulkOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus {selectedIds.size} sesi terpilih?</AlertDialogTitle>
            <AlertDialogDescription>
              Semua sesi yang kamu pilih beserta seluruh pesannya akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleteMutation.isPending}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDeleteMutation.isPending || selectedIds.size === 0}
              onClick={(e) => {
                e.preventDefault();
                bulkDeleteMutation.mutate({ data: { ids: Array.from(selectedIds) } });
              }}
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleteMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Menghapus...</>
              ) : (
                <>Hapus {selectedIds.size} Sesi</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteSessionId} onOpenChange={(open) => !open && setDeleteSessionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus sesi chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Sesi ini beserta semua pesannya akan dihapus permanen dari database. Tindakan ini tidak dapat dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSessionMutation.isPending}>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteSessionMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteSessionId) {
                  deleteSessionMutation.mutate({ id: deleteSessionId });
                }
              }}
              data-testid="button-confirm-delete-session"
            >
              {deleteSessionMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Menghapus...</>
              ) : (
                "Hapus"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={cleanupOpen} onOpenChange={(open) => !bulkDeleteMutation.isPending && setCleanupOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hapus Sesi Chat Lama</DialogTitle>
            <DialogDescription>
              Hapus semua sesi chat yang pesan terakhirnya lebih lama dari jumlah hari di bawah ini. Berguna untuk mengurangi ukuran database.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="text-sm font-medium">Lebih lama dari (hari)</label>
            <Input
              type="number"
              min={1}
              value={cleanupDays}
              onChange={(e) => setCleanupDays(e.target.value)}
              data-testid="input-cleanup-days"
            />
            <p className="text-xs text-muted-foreground">
              Contoh: <strong>30</strong> akan menghapus sesi yang tidak aktif lebih dari 30 hari terakhir.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupOpen(false)} disabled={bulkDeleteMutation.isPending}>
              Batal
            </Button>
            <Button
              variant="destructive"
              disabled={bulkDeleteMutation.isPending || !cleanupDays || Number(cleanupDays) < 1}
              onClick={() => bulkDeleteMutation.mutate({ data: { olderThanDays: Number(cleanupDays) } })}
              data-testid="button-confirm-cleanup"
            >
              {bulkDeleteMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Menghapus...</>
              ) : (
                <><Trash2 className="h-4 w-4 mr-2" /> Hapus Sekarang</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChatSessionDetailModal({ sessionId, onClose, onDelete }: { sessionId: string, onClose: () => void, onDelete?: () => void }) {
  const { data, isLoading } = useGetChatSession(sessionId, { query: { enabled: !!sessionId, queryKey: getGetChatSessionQueryKey(sessionId) } });
  const flagMessage = useFlagChatMessage();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleFlag = (messageId: string, currentFlag: boolean) => {
    flagMessage.mutate(
      { id: messageId, data: { needsReview: !currentFlag } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetChatSessionQueryKey(sessionId) });
          queryClient.invalidateQueries({ queryKey: getGetChatStatsQueryKey() });
          toast({
            title: !currentFlag ? "Message Flagged" : "Flag Removed",
            description: "Message status has been updated.",
          });
        }
      }
    );
  };

  return (
    <Dialog open={!!sessionId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <DialogTitle>Chat Session Details</DialogTitle>
              <DialogDescription>
                {data ? `Started ${format(new Date(data.session.createdAt), "PPpp")}` : "Loading..."}
              </DialogDescription>
            </div>
            {onDelete && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                onClick={onDelete}
                data-testid="button-delete-session-from-modal"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Hapus Sesi
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-4 space-y-4 mt-4">
          {isLoading ? (
            <div className="h-32 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            data?.messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg p-3 ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted border"
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
                <div className="flex items-center gap-2 mt-1 px-1">
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(msg.createdAt), "HH:mm")}
                  </span>
                  {msg.role === "assistant" && (
                    <>
                      {msg.answerSource && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                          {msg.answerSource}
                        </Badge>
                      )}
                      {msg.confidence !== null && msg.confidence !== undefined && (
                        <span className={`text-[10px] ${msg.confidence > 0.8 ? "text-green-600" : "text-yellow-600"}`}>
                          {(msg.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-5 w-5 ${msg.needsReview ? "text-destructive hover:text-destructive" : "text-muted-foreground"}`}
                        onClick={() => handleFlag(msg.id, msg.needsReview)}
                        title={msg.needsReview ? "Remove Flag" : "Flag for Review"}
                      >
                        <AlertTriangle className="h-3 w-3" />
                      </Button>
                      {msg.needsReview && msg.reportReason && (
                        <span className="text-[10px] text-destructive italic max-w-[160px] truncate" title={msg.reportReason}>
                          "{msg.reportReason}"
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
