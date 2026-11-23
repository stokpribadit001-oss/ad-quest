import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

// Port: the original used a build-time macro that only emitted HTML form
// attributes (name/autoComplete hints). A no-op recursive proxy keeps every
// `{...FIELDS.x.y}` spread valid while rendering identical behaviour.
const FIELDS: any = new Proxy({}, { get: () => FIELDS });

type Session = { id: number; name: string; role: "admin" | "guru" | "siswa" | "pengawas" };
type ExamT = ApiResponse<typeof api, "listExams">["exams"][number];
type UserT = ApiResponse<typeof api, "listUsers">["users"][number];
type AttemptT = ApiResponse<typeof api, "listAttempts">["attempts"][number];
type QuestionT = ApiResponse<typeof api, "listQuestions">["questions"][number];
type DraftQ = {
  type: "pilihan_ganda" | "isian" | "essay" | "angka";
  prompt: string;
  options: string[];
  correctAnswer: string;
  points: number;
};

const TYPE_LABEL: Record<DraftQ["type"], string> = {
  pilihan_ganda: "Pilihan Ganda",
  isian: "Isian Singkat",
  essay: "Essay",
  angka: "Jawaban Angka",
};

// Poin draf AI selalu dibagi ulang seadil mungkin agar totalnya tepat 100,
// jadi nilai siswa tampil sebagai nilai yang didapat / 100.
function rebalanceDraftPoints(drafts: DraftQ[]): DraftQ[] {
  const n = drafts.length;
  if (n === 0) return drafts;
  const base = Math.floor(100 / n);
  const rest = 100 - base * n;
  return drafts.map((d, i) => ({ ...d, points: base + (i < rest ? 1 : 0) }));
}

const SESSION_KEY = "adquest-session";

// AD QUEST berjalan di iframe sandbox tanpa allow-same-origin, jadi akses
// localStorage melempar SecurityError. Semua akses dibungkus try/catch dan
// jatuh ke penyimpanan in-memory agar login tetap berfungsi.
let memorySession: string | null = null;

function storageGet(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return memorySession;
  }
}

function storageSet(value: string): void {
  memorySession = value;
  try {
    localStorage.setItem(SESSION_KEY, value);
  } catch {
    /* sandbox: sesi hanya tersimpan in-memory */
  }
}

function storageRemove(): void {
  memorySession = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* sandbox: abaikan */
  }
}

function loadSession(): Session | null {
  try {
    const raw = storageGet();
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (
      v &&
      typeof v === "object" &&
      typeof (v as Session).id === "number" &&
      typeof (v as Session).name === "string" &&
      ["admin", "guru", "siswa", "pengawas"].includes((v as Session).role)
    ) {
      return v as Session;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------- UI primitives ----------

const ICONS = {
  home: (
    <>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </>
  ),
  layers: (
    <>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M2 14h4" />
      <path d="M10 8h4" />
      <path d="M18 16h4" />
    </>
  ),
  key: (
    <>
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </>
  ),
  sparkles: (
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  fileText: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  gradCap: (
    <>
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
      <path d="M22 10v6" />
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  bookOpen: (
    <>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>
  ),
  smartphone: (
    <>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </>
  ),
  monitor: (
    <>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  share: (
    <>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="m16 6-4-4-4 4" />
      <path d="M12 2v13" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
} as const;

type IconName = keyof typeof ICONS;

function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

function Btn({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
  ariaLabel,
  submit,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "amber" | "danger" | "soft";
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  submit?: boolean;
}) {
  const styles: Record<string, string> = {
    primary: "bg-[var(--accent)] text-[var(--accent-ink)] font-bold shadow-card hover:brightness-110",
    amber: "bg-[var(--amber)] text-[#231600] font-bold shadow-card hover:brightness-105",
    ghost: "bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] font-semibold hover:bg-[var(--surface2)]",
    soft: "bg-[var(--surface2)] text-[var(--text)] font-semibold hover:brightness-95",
    danger: "bg-[var(--danger)] text-white font-bold shadow-card hover:brightness-110",
  };
  return (
    <button
      type={submit ? "submit" : "button"}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-bold text-[var(--text)]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-[var(--dim)]">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-base text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15";

function StatCard({
  label,
  value,
  sub,
  icon,
  tint = "green",
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon?: IconName;
  tint?: "green" | "amber";
}) {
  return (
    <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">{label}</p>
        {icon ? (
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              tint === "amber"
                ? "bg-[var(--amber-soft)] text-[var(--amber)]"
                : "bg-[var(--accent-soft)] text-[var(--accent)]"
            }`}
          >
            <Icon name={icon} size={18} />
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-3xl font-extrabold text-[var(--text)]">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-[var(--dim)]">{sub}</p> : null}
    </div>
  );
}

function Badge({ children, tone = "soft" }: { children: React.ReactNode; tone?: "soft" | "green" | "amber" | "red" }) {
  const tones: Record<string, string> = {
    soft: "bg-[var(--surface2)] text-[var(--dim)]",
    green: "bg-[var(--accent)] text-[var(--accent-ink)]",
    amber: "bg-[var(--amber)] text-[#231600]",
    red: "bg-[var(--danger)] text-white",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ConfirmBar({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="rounded-2xl border-2 border-[var(--amber)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold text-[var(--text)]">{message}</p>
      <div className="mt-3 flex gap-2">
        <Btn variant="amber" onClick={onConfirm} disabled={busy}>
          {busy ? "Memproses…" : confirmLabel}
        </Btn>
        <Btn variant="ghost" onClick={onCancel}>
          Batal
        </Btn>
      </div>
    </div>
  );
}

function TopBar({
  session,
  onLogout,
  hideLogout,
}: {
  session: Session;
  onLogout: () => void;
  hideLogout?: boolean;
}) {
  const roleLabel =
    session.role === "admin" ? "Admin" : session.role === "guru" ? "Guru" : session.role === "pengawas" ? "Pengawas" : "Siswa";
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)]/90 pt-safe backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-deep)] text-[var(--accent-ink)] shadow-card">
            <Icon name="gradCap" size={22} />
          </div>
          <div>
            <p className="text-base font-extrabold leading-tight tracking-tight text-[var(--text)]">AD QUEST</p>
            <p className="text-xs leading-tight text-[var(--dim)]">
              {session.name} · {roleLabel}
            </p>
          </div>
        </div>
        {!hideLogout ? (
          <Btn variant="ghost" onClick={onLogout} ariaLabel="Keluar akun">
            <Icon name="logout" size={16} />
            Keluar
          </Btn>
        ) : null}
      </div>
    </header>
  );
}

function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; icon?: IconName; shortLabel?: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Menu utama"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--border)] bg-[var(--surface)]/95 px-2 pb-safe pt-1.5 shadow-[0_-6px_24px_-12px_rgb(18_42_32/0.35)] backdrop-blur lg:sticky lg:top-24 lg:z-10 lg:w-60 lg:shrink-0 lg:flex-col lg:gap-1 lg:rounded-3xl lg:border lg:bg-[var(--surface)] lg:p-2 lg:shadow-card lg:backdrop-blur-none"
    >
      <p className="hidden px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-widest text-[var(--dim)] lg:block">
        Menu
      </p>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          aria-current={active === t.id ? "page" : undefined}
          className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-xl px-1 py-1.5 text-[11px] font-bold transition lg:min-h-12 lg:flex-none lg:flex-row lg:justify-start lg:gap-2.5 lg:px-3.5 lg:py-2.5 lg:text-sm ${
            active === t.id
              ? "bg-[var(--accent)] text-[var(--accent-ink)] shadow-card"
              : "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]"
          }`}
        >
          {t.icon ? <Icon name={t.icon} size={20} /> : null}
          <span className="lg:hidden">{t.shortLabel ?? t.label}</span>
          <span className="hidden lg:inline">{t.label}</span>
        </button>
      ))}
      <p className="mt-auto hidden px-3 pb-2 pt-4 text-[11px] leading-relaxed text-[var(--dim)] lg:block">
        AD QUEST bisa dipasang sebagai aplikasi di HP & komputer — lihat panel
        “Pasang Aplikasi” di Beranda.
      </p>
    </nav>
  );
}

// ---------- Pasang sebagai aplikasi (Android / iPhone / Komputer) ----------

type DeviceKind = "android" | "ios" | "komputer";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function detectDevice(): DeviceKind {
  if (typeof navigator === "undefined") return "komputer";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  // iPad modern melaporkan diri sebagai Mac — layar sentuh membedakannya.
  if (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  return "komputer";
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    /* abaikan */
  }
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const INSTALL_STEPS: Record<DeviceKind, { title: string; icon: IconName; steps: string[] }> = {
  android: {
    title: "Android",
    icon: "smartphone",
    steps: [
      "Buka AD QUEST di Chrome, lalu ketuk menu ⋮ di kanan atas.",
      "Pilih “Pasang aplikasi” atau “Tambahkan ke Layar Utama”.",
      "Ketuk Pasang — ikon AD QUEST muncul di layar utama & daftar aplikasi, dan terbuka layar penuh seperti aplikasi biasa.",
    ],
  },
  ios: {
    title: "iPhone / iPad",
    icon: "smartphone",
    steps: [
      "Buka AD QUEST di Safari, lalu ketuk tombol Bagikan (kotak dengan panah ke atas).",
      "Gulir ke bawah lalu pilih “Tambahkan ke Layar Utama”.",
      "Ketuk Tambah — AD QUEST terbuka dari ikon di layar utama, layar penuh tanpa bilah Safari.",
    ],
  },
  komputer: {
    title: "Komputer",
    icon: "monitor",
    steps: [
      "Buka AD QUEST di Chrome atau Edge, lalu klik ikon Pasang di ujung kanan kolom alamat (atau menu ⋮ → “Pasang AD QUEST…”).",
      "Klik Pasang / Install.",
      "AD QUEST menjadi jendela aplikasi sendiri di komputer dan tersemat di taskbar (Windows) atau Dock (Mac) seperti aplikasi biasa.",
    ],
  },
};

function InstallAppCard({ compact = false }: { compact?: boolean }) {
  const [device, setDevice] = useState<DeviceKind>(() => detectDevice());
  const [standalone, setStandalone] = useState<boolean>(() => detectStandalone());
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setStandalone(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (dismissed) return null;

  if (standalone) {
    return (
      <section
        aria-label="Status aplikasi terpasang"
        className="flex items-center gap-3 rounded-3xl border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--accent-ink)]">
          <Icon name="checkCircle" size={20} />
        </span>
        <div>
          <p className="text-sm font-extrabold text-[var(--text)]">AD QUEST berjalan sebagai aplikasi</p>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            Anda membukanya dari ikon aplikasi di perangkat ini — layar penuh, tanpa bilah browser.
          </p>
        </div>
      </section>
    );
  }

  const active = INSTALL_STEPS[device];
  const canPrompt = deferred !== null && device !== "ios";

  return (
    <section
      aria-label="Pasang AD QUEST sebagai aplikasi"
      className="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card"
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Tutup panel pasang aplikasi"
        className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-[var(--dim)] transition hover:bg-[var(--surface2)] hover:text-[var(--text)]"
      >
        <Icon name="x" size={17} />
      </button>
      <div className="flex items-start gap-3 pr-8">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent)] text-[var(--accent-ink)] shadow-card">
          <Icon name="download" size={21} />
        </span>
        <div>
          <h2 className="text-base font-extrabold text-[var(--text)]">Pasang AD QUEST sebagai Aplikasi</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
            Satu aplikasi untuk Android, iPhone, dan komputer — tanpa toko aplikasi.
            Pasang sekali, lalu buka dari ikon seperti aplikasi biasa.
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-1.5 rounded-2xl bg-[var(--surface2)] p-1.5" role="tablist" aria-label="Pilih perangkat Anda">
        {(Object.keys(INSTALL_STEPS) as DeviceKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={device === kind}
            onClick={() => setDevice(kind)}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-sm font-bold transition ${
              device === kind
                ? "bg-[var(--surface)] text-[var(--accent)] shadow-card ring-1 ring-[var(--border)]"
                : "text-[var(--dim)] hover:text-[var(--text)]"
            }`}
          >
            <Icon name={INSTALL_STEPS[kind].icon} size={16} />
            {INSTALL_STEPS[kind].title}
          </button>
        ))}
      </div>

      {canPrompt ? (
        <Btn
          className="mt-4 w-full"
          onClick={async () => {
            if (!deferred) return;
            try {
              await deferred.prompt();
              const choice = await deferred.userChoice;
              if (choice.outcome === "accepted") {
                setStandalone(true);
              } else {
                setNote("Pemasangan dibatalkan. Anda bisa memasang kapan saja lewat langkah di bawah ini.");
              }
            } catch {
              setNote("Tombol pasang otomatis belum tersedia di browser ini — ikuti langkah manual di bawah ini.");
            }
            setDeferred(null);
          }}
          ariaLabel="Pasang AD QUEST sekarang"
        >
          <Icon name="download" size={17} />
          Pasang Sekarang di {active.title}
        </Btn>
      ) : null}
      {note ? <p className="mt-3 text-sm font-semibold text-[var(--amber)]">{note}</p> : null}

      {!compact || !canPrompt ? (
        <ol className="mt-4 space-y-2.5">
          {active.steps.map((step, i) => (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-[var(--text)]">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-extrabold text-[var(--accent)]">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {device === "ios" ? (
        <p className="mt-3 flex items-center gap-2 text-xs leading-relaxed text-[var(--dim)]">
          <Icon name="share" size={14} className="shrink-0" />
          Di iPhone, pemasangan hanya bisa dari Safari lewat tombol Bagikan — tidak ada tombol pasang otomatis.
        </p>
      ) : null}
    </section>
  );
}

function SectionTitle({ icon, children, right }: { icon: IconName; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2.5 font-extrabold text-[var(--text)]">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon name={icon} size={17} />
        </span>
        {children}
      </h3>
      {right ?? null}
    </div>
  );
}

// ---------- Login ----------

function LoginView({ onLogin }: { onLogin: (s: Session) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({}) });
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: () => api.getBootstrap({}) });
  const login = useMutation({
    mutationFn: (k: string) => api.loginWithKey({ key: k }),
    onSuccess: (res) => {
      if (res.ok && res.user) {
        const s: Session = { id: res.user.id, name: res.user.name, role: res.user.role };
        storageSet(JSON.stringify(s));
        onLogin(s);
      } else {
        setError(res.error ?? "Key tidak dikenal.");
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Gagal masuk. Coba lagi."),
  });

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <main className="mx-auto grid min-h-screen w-full max-w-md content-center gap-5 px-5 py-10 lg:max-w-5xl lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-8">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[var(--accent)] via-[var(--accent)] to-[var(--accent-deep)] p-6 text-[var(--accent-ink)] shadow-pop lg:p-8">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.13]"
            style={{
              backgroundImage: "radial-gradient(rgb(255 255 255) 1.2px, transparent 1.2px)",
              backgroundSize: "18px 18px",
            }}
          />
          <div className="relative">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25">
                <Icon name="gradCap" size={26} />
              </span>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest opacity-80">Platform Ujian Sekolah</p>
                <h1 className="text-3xl font-extrabold leading-none tracking-tight">AD QUEST</h1>
              </div>
            </div>
            <p className="mt-4 text-sm font-medium leading-relaxed opacity-90">
              Satu Key untuk semua. Masukkan Key Anda — sistem otomatis mengenali akun Admin, Guru, Pengawas, atau Siswa.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {(
                [
                  ["key", "Login 1 Key"],
                  ["sparkles", "Soal Dibantu AI"],
                  ["inbox", "Hasil ke Guru"],
                ] as Array<[IconName, string]>
              ).map(([icon, label]) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full bg-black/15 px-2.5 py-1 text-xs font-bold"
                >
                  <Icon name={icon} size={13} />
                  {label}
                </span>
              ))}
            </div>
            {settings.data?.schoolName ? (
              <p className="mt-3 inline-block rounded-full bg-white/15 px-3 py-1 text-xs font-bold ring-1 ring-white/25">
                {settings.data.schoolName}
              </p>
            ) : null}
          </div>
        </div>

        <form
          className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-pop"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) {
              setError("Isi Key dulu ya.");
              return;
            }
            setError("");
            login.mutate(key.trim());
          }}
        >
          <Field label="Key Anda">
            <input
              {...FIELDS.loginWithKey.key}
              aria-label="Key login"
              className={`${inputCls} text-center text-lg font-bold uppercase tracking-widest`}
              placeholder="GRU-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </Field>
          {error ? (
            <p role="alert" className="mt-3 rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
              {error}
            </p>
          ) : null}
          <Btn className="mt-4 w-full" disabled={login.isPending} submit ariaLabel="Masuk ke AD QUEST">
            <Icon name="key" size={17} />
            {login.isPending ? "Memeriksa Key…" : "Masuk"}
          </Btn>
          <p className="mt-4 text-center text-xs leading-relaxed text-[var(--dim)]">
            Belum punya Key? Minta Key login kepada admin sekolah atau guru Anda.
          </p>
        </form>

        {bootstrap.data?.needsSetup ? (
          <div className="rounded-3xl border-2 border-[var(--amber)] bg-[var(--surface)] p-6 shadow-card lg:col-span-2">
            <h2 className="text-lg font-extrabold text-[var(--text)]">Penyiapan oleh Muse</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              AD QUEST belum memiliki akun Admin. Demi keamanan, akun Admin pertama tidak bisa
              dibuat dari halaman ini — Key Admin dibuatkan oleh Muse. Minta Muse membuatkan
              Key Admin, lalu masuk dengan Key tersebut.
            </p>
          </div>
        ) : null}

        {settings.data?.announcement ? (
          <div className="rounded-2xl border border-[var(--amber)] bg-[var(--surface)] p-4 lg:col-span-2">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--amber)]">Pengumuman</p>
            <p className="mt-1 text-sm text-[var(--text)]">{settings.data.announcement}</p>
          </div>
        ) : null}

        <div className="lg:col-span-2">
          <InstallAppCard />
        </div>
      </main>
    </div>
  );
}

// ---------- Shared: user management (admin & guru peserta) ----------

function UserManager({ session, mode }: { session: Session; mode: "admin" | "guru" }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"guru" | "siswa" | "pengawas">(mode === "guru" ? "siswa" : "guru");
  const [formError, setFormError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<UserT | null>(null);
  const [lastCreated, setLastCreated] = useState<UserT | null>(null);

  const users = useQuery({
    queryKey: ["users", session.id, mode],
    queryFn: () => api.listUsers({ actorId: session.id, scope: mode === "guru" ? "mine" : "all" }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });
  const create = useMutation({
    mutationFn: () =>
      api.createUser({
        actorId: session.id,
        name: name.trim(),
        role: mode === "guru" ? (role === "pengawas" ? "pengawas" : "siswa") : role,
      }),
    onSuccess: (res) => {
      setLastCreated(res.user);
      setName("");
      invalidate();
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : "Gagal membuat akun."),
  });
  const lock = useMutation({
    mutationFn: (v: { userId: number; locked: boolean }) =>
      api.setUserLocked({ actorId: session.id, userId: v.userId, locked: v.locked }),
    onSuccess: invalidate,
    onError: (e) => setFormError(e instanceof Error ? e.message : "Gagal mengubah status kunci."),
  });
  const regen = useMutation({
    mutationFn: (userId: number) => api.regenerateUserKey({ actorId: session.id, userId }),
    onSuccess: invalidate,
    onError: (e) => setFormError(e instanceof Error ? e.message : "Gagal membuat Key baru."),
  });
  const changeRole = useMutation({
    mutationFn: (v: { userId: number; role: "admin" | "guru" | "siswa" | "pengawas" }) =>
      api.updateUserRole({ actorId: session.id, userId: v.userId, role: v.role }),
    onSuccess: invalidate,
    onError: (e) => setFormError(e instanceof Error ? e.message : "Gagal mengubah role."),
  });
  const del = useMutation({
    mutationFn: (userId: number) => api.deleteUser({ actorId: session.id, userId }),
    onSuccess: () => {
      setConfirmDelete(null);
      invalidate();
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : "Gagal menghapus akun."),
  });

  const list = (users.data?.users ?? []).filter((u) => u.id !== session.id);

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
        <h2 className="text-lg font-extrabold text-[var(--text)]">
          {mode === "admin" ? "Buat Akun Baru" : "Tambah Peserta / Pengawas"}
        </h2>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) {
              setFormError("Nama tidak boleh kosong.");
              return;
            }
            setFormError("");
            create.mutate();
          }}
        >
          <Field label={mode === "admin" ? "Nama pengguna" : "Nama peserta"}>
            <input
              {...FIELDS.createUser.name}
              aria-label="Nama pengguna baru"
              className={inputCls}
              placeholder="cth. Ibu Sari / Budi Santoso"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <select
              aria-label="Role pengguna baru"
              className={inputCls}
              value={role}
              onChange={(e) => setRole(e.target.value as "guru" | "siswa" | "pengawas")}
            >
              {mode === "admin" ? <option value="guru">Guru</option> : null}
              <option value="siswa">Siswa</option>
              <option value="pengawas">Pengawas</option>
            </select>
          </Field>
          {mode === "guru" && role === "pengawas" ? (
            <p className="text-xs leading-relaxed text-[var(--dim)]">
              Pengawas dapat memantau peserta pada ujian-ujian Anda (per mata pelajaran & kelas),
              dan membuka kunci akun peserta yang terkunci saat ujian.
            </p>
          ) : null}
          {formError ? (
            <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
              {formError}
            </p>
          ) : null}
          <Btn disabled={create.isPending} submit ariaLabel="Buat akun dan Key">
            {create.isPending ? "Membuat…" : "Buat Akun + Key"}
          </Btn>
        </form>
        {lastCreated ? (
          <div className="mt-4 rounded-2xl bg-[var(--surface2)] p-4">
            <p className="text-sm font-bold text-[var(--text)]">
              Akun {lastCreated.name} ({lastCreated.role}) berhasil dibuat.
            </p>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Key login: <span className="font-extrabold tracking-wider text-[var(--accent)]">{lastCreated.accessKey}</span>
            </p>
            <p className="text-xs text-[var(--dim)]">Bagikan Key ini kepada pemilik akun. Key juga selalu terlihat di daftar bawah.</p>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-extrabold text-[var(--text)]">
          {mode === "admin" ? "Semua Pengguna" : "Daftar Peserta & Pengawas Saya"} ({list.length})
        </h2>
        {users.isPending ? <p className="text-sm text-[var(--dim)]">Memuat…</p> : null}
        {list.length === 0 && !users.isPending ? (
          <p className="rounded-2xl bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
            Belum ada akun. Buat akun pertama lewat formulir di atas.
          </p>
        ) : null}
        <div className="grid items-start gap-3 lg:grid-cols-2">
        {list.map((u) => (
          <article key={u.id} className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-extrabold text-[var(--text)]">{u.name}</p>
                <p className="text-xs text-[var(--dim)]">
                  Key: <span className="font-bold tracking-wider text-[var(--accent)]">{u.accessKey}</span>
                </p>
              </div>
              <div className="flex gap-1.5">
                <Badge tone={u.role === "admin" ? "amber" : u.role === "guru" || u.role === "pengawas" ? "green" : "soft"}>
                  {u.role === "admin" ? "Admin" : u.role === "guru" ? "Guru" : u.role === "pengawas" ? "Pengawas" : "Siswa"}
                </Badge>
                {u.locked ? <Badge tone="red">Terkunci</Badge> : <Badge tone="soft">Aktif</Badge>}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn
                variant="soft"
                onClick={() => lock.mutate({ userId: u.id, locked: !u.locked })}
                ariaLabel={`${u.locked ? "Buka kunci" : "Kunci"} akun ${u.name}`}
              >
                {u.locked ? "Buka Kunci" : "Kunci Akun"}
              </Btn>
              <Btn variant="soft" onClick={() => regen.mutate(u.id)} ariaLabel={`Buat Key baru untuk ${u.name}`}>
                Key Baru
              </Btn>
              {mode === "admin" ? (
                <>
                  <label className="inline-flex items-center gap-2 rounded-xl bg-[var(--surface2)] px-3 py-2 text-sm font-semibold text-[var(--text)]">
                    Role
                    <select
                      aria-label={`Ubah role ${u.name}`}
                      className="bg-transparent font-bold outline-none"
                      value={u.role}
                      onChange={(e) =>
                        changeRole.mutate({ userId: u.id, role: e.target.value as "admin" | "guru" | "siswa" | "pengawas" })
                      }
                    >
                      <option value="admin">Admin</option>
                      <option value="guru">Guru</option>
                      <option value="pengawas">Pengawas</option>
                      <option value="siswa">Siswa</option>
                    </select>
                  </label>
                  <Btn variant="danger" onClick={() => setConfirmDelete(u)} ariaLabel={`Hapus akun ${u.name}`}>
                    Hapus
                  </Btn>
                </>
              ) : null}
            </div>
            {confirmDelete?.id === u.id ? (
              <div className="mt-3">
                <ConfirmBar
                  message={`Hapus akun ${u.name}? Hasil ujiannya ikut terhapus dan tidak bisa dikembalikan.`}
                  confirmLabel="Ya, Hapus"
                  busy={del.isPending}
                  onConfirm={() => del.mutate(u.id)}
                  onCancel={() => setConfirmDelete(null)}
                />
              </div>
            ) : null}
          </article>
        ))}
        </div>
      </section>
    </div>
  );
}

// ---------- Shared: attempts inbox ----------

function AttemptDetailView({
  session,
  attemptId,
  onBack,
}: {
  session: Session;
  attemptId: number;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [essayInputs, setEssayInputs] = useState<Record<number, string>>({});
  const [gradeMsg, setGradeMsg] = useState("");
  const detail = useQuery({
    queryKey: ["attempt-detail", attemptId],
    queryFn: () => api.getAttemptDetail({ actorId: session.id, attemptId }),
  });
  const grade = useMutation({
    mutationFn: () =>
      api.gradeEssay({
        actorId: session.id,
        attemptId,
        scores: Object.entries(essayInputs)
          .filter(([, v]) => v.trim() !== "")
          .map(([k, v]) => ({ questionId: Number(k), score: Math.max(0, Math.floor(Number(v) || 0)) })),
      }),
    onSuccess: (res) => {
      setGradeMsg(`Nilai tersimpan. Total: ${res.totalScore} / ${res.maxScore}.`);
      qc.invalidateQueries({ queryKey: ["attempt-detail", attemptId] });
      qc.invalidateQueries({ queryKey: ["attempts"] });
    },
    onError: (e) => setGradeMsg(e instanceof Error ? e.message : "Gagal menyimpan nilai."),
  });

  const d = detail.data;
  return (
    <div className="space-y-4">
      <Btn variant="ghost" onClick={onBack} ariaLabel="Kembali ke kotak masuk hasil">
        ← Kembali
      </Btn>
      {detail.isPending ? <p className="text-sm text-[var(--dim)]">Memuat detail…</p> : null}
      {detail.isError ? (
        <p role="alert" className="rounded-2xl bg-[var(--danger)]/10 p-4 text-sm font-semibold text-[var(--danger)]">
          Detail tidak dapat dimuat.
        </p>
      ) : null}
      {d ? (
        <>
          <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
            <h2 className="text-xl font-extrabold text-[var(--text)]">{d.attempt.studentName}</h2>
            <p className="text-sm text-[var(--dim)]">{d.attempt.examTitle}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <Badge tone={d.attempt.status === "graded" ? "green" : d.attempt.status === "submitted" ? "amber" : "soft"}>
                {d.attempt.status === "graded" ? "Sudah dinilai" : d.attempt.status === "submitted" ? "Menunggu penilaian essay" : "Sedang berlangsung"}
              </Badge>
              <Badge>Dikumpulkan: {fmtDate(d.attempt.submittedAt)}</Badge>
              <Badge>
                Nilai otomatis: {d.attempt.autoScore ?? "—"} · Total: {d.attempt.totalScore ?? "—"} / {d.attempt.maxScore}
              </Badge>
              {d.attempt.attemptLocked ? (
                <Badge tone="red">Ujian terkunci: {d.attempt.lockReason || "pelanggaran terdeteksi"}</Badge>
              ) : null}
            </div>
          </section>

          <ol className="space-y-3">
            {d.items.map((it, idx) => (
              <li key={it.questionId} className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                    Soal {idx + 1} · {TYPE_LABEL[it.type]} · {it.points} poin
                  </p>
                  {it.type !== "essay" ? (
                    <Badge tone={it.earnedAuto === it.points && it.studentAnswer.trim() !== "" ? "green" : "red"}>
                      {it.earnedAuto} poin
                    </Badge>
                  ) : (
                    <Badge tone={it.essayScore != null ? "green" : "amber"}>
                      {it.essayScore != null ? `Essay: ${it.essayScore} poin` : "Belum dinilai"}
                    </Badge>
                  )}
                </div>
                <p className="mt-2 font-semibold text-[var(--text)]">{it.prompt}</p>
                <div className="mt-3 space-y-1.5 text-sm">
                  <p className="rounded-xl bg-[var(--surface2)] px-3 py-2 text-[var(--text)]">
                    <span className="font-bold">Jawaban siswa: </span>
                    {it.studentAnswer.trim() === "" ? <em className="text-[var(--dim)]">(kosong)</em> : it.studentAnswer}
                  </p>
                  <p className="rounded-xl bg-[var(--accent)]/10 px-3 py-2 text-[var(--text)]">
                    <span className="font-bold">{it.type === "essay" ? "Pedoman jawaban: " : "Kunci: "}</span>
                    {it.correctAnswer || "—"}
                  </p>
                </div>
                {it.type === "essay" ? (
                  <div className="mt-3 flex items-end gap-2">
                    <Field label={`Nilai essay (maks ${it.points})`}>
                      <input
                        {...FIELDS.gradeEssay.scores.score}
                        aria-label={`Nilai essay soal ${idx + 1}`}
                        type="number"
                        className={`${inputCls} w-32`}
                        placeholder={it.essayScore != null ? String(it.essayScore) : "0"}
                        value={essayInputs[it.questionId] ?? ""}
                        onChange={(e) =>
                          setEssayInputs((prev) => ({ ...prev, [it.questionId]: e.target.value }))
                        }
                      />
                    </Field>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          {d.items.some((i) => i.type === "essay") ? (
            <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
              <Btn onClick={() => grade.mutate()} disabled={grade.isPending} ariaLabel="Simpan nilai essay">
                {grade.isPending ? "Menyimpan…" : "Simpan Nilai Essay"}
              </Btn>
              {gradeMsg ? <p className="mt-2 text-sm font-semibold text-[var(--accent)]">{gradeMsg}</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function AttemptsInbox({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: (attemptId: number) => void;
}) {
  const attempts = useQuery({
    queryKey: ["attempts", session.id],
    queryFn: () => api.listAttempts({ actorId: session.id }),
  });
  const list = attempts.data?.attempts ?? [];
  return (
    <section className="space-y-3">
      <SectionTitle icon="inbox">Kotak Masuk Hasil ({list.length})</SectionTitle>
      {attempts.isPending ? <p className="text-sm text-[var(--dim)]">Memuat…</p> : null}
      {list.length === 0 && !attempts.isPending ? (
        <p className="rounded-2xl bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
          Belum ada hasil masuk. Hasil muncul di sini begitu siswa mengumpulkan ujian.
        </p>
      ) : null}
      <div className="grid items-start gap-3 lg:grid-cols-2">
      {list.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(a.id)}
          aria-label={`Lihat hasil ${a.studentName} pada ${a.examTitle}`}
          className="block w-full rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left shadow-card"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-extrabold text-[var(--text)]">{a.studentName}</p>
              <p className="text-sm text-[var(--dim)]">{a.examTitle}</p>
              <p className="text-xs text-[var(--dim)]">
                Mulai {fmtDate(a.startedAt)} · Kumpul {fmtDate(a.submittedAt)} · Terjawab {a.answeredCount} soal
              </p>
            </div>
            <div className="text-right">
              {a.attemptLocked ? (
                <Badge tone="red">Terkunci · pelanggaran {a.violations}×</Badge>
              ) : (
                <Badge tone={a.status === "graded" ? "green" : a.status === "submitted" ? "amber" : "soft"}>
                  {a.status === "graded" ? "Dinilai" : a.status === "submitted" ? "Perlu dinilai" : "Berlangsung"}
                </Badge>
              )}
              <p className="mt-1 text-sm font-extrabold text-[var(--text)]">
                {a.totalScore ?? "—"} / {a.maxScore}
              </p>
            </div>
          </div>
        </button>
      ))}
      </div>
    </section>
  );
}

// ---------- Teacher: exam editor ----------

function QuestionForm({
  initial,
  onSave,
  onCancel,
  busy,
  error,
}: {
  initial: DraftQ;
  onSave: (q: DraftQ) => void;
  onCancel?: () => void;
  busy?: boolean;
  error?: string;
}) {
  const [q, setQ] = useState<DraftQ>(initial);
  const [localError, setLocalError] = useState("");
  const setOpt = (i: number, v: string) =>
    setQ((prev) => ({ ...prev, options: prev.options.map((o, idx) => (idx === i ? v : o)) }));

  return (
    <form
      className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface2)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!q.prompt.trim()) {
          setLocalError("Pertanyaan tidak boleh kosong.");
          return;
        }
        if (q.type === "pilihan_ganda") {
          const filled = q.options.map((o) => o.trim()).filter(Boolean);
          if (filled.length < 2) {
            setLocalError("Isi minimal 2 pilihan jawaban.");
            return;
          }
          if (!filled.some((o) => o.toLowerCase() === q.correctAnswer.trim().toLowerCase())) {
            setLocalError("Pilih kunci jawaban dari salah satu pilihan.");
            return;
          }
          onSave({ ...q, options: filled });
          return;
        }
        if (q.type !== "essay" && !q.correctAnswer.trim()) {
          setLocalError("Kunci jawaban tidak boleh kosong.");
          return;
        }
        onSave(q);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Jenis soal">
          <select
            aria-label="Jenis soal"
            className={inputCls}
            value={q.type}
            onChange={(e) => {
              const t = e.target.value as DraftQ["type"];
              setQ((prev) => ({
                ...prev,
                type: t,
                options: t === "pilihan_ganda" && prev.options.length === 0 ? ["", "", "", ""] : prev.options,
              }));
            }}
          >
            <option value="pilihan_ganda">Pilihan Ganda</option>
            <option value="isian">Isian Singkat</option>
            <option value="essay">Essay</option>
            <option value="angka">Jawaban Angka</option>
          </select>
        </Field>
        <Field label="Poin">
          <input
            {...FIELDS.saveQuestion.question.points}
            aria-label="Poin soal"
            type="number"
            className={inputCls}
            value={q.points}
            onChange={(e) => setQ((prev) => ({ ...prev, points: Number(e.target.value) || 10 }))}
          />
        </Field>
      </div>
      <Field label="Pertanyaan">
        <textarea
          {...FIELDS.saveQuestion.question.prompt}
          aria-label="Teks pertanyaan"
          className={`${inputCls} min-h-20`}
          value={q.prompt}
          onChange={(e) => setQ((prev) => ({ ...prev, prompt: e.target.value }))}
          placeholder="Tulis pertanyaan di sini…"
        />
      </Field>
      {q.type === "pilihan_ganda" ? (
        <div className="space-y-2">
          <p className="text-sm font-bold text-[var(--text)]">Pilihan jawaban — ketuk lingkaran untuk menjadikannya kunci</p>
          {q.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="radio"
                name={`correct-${initial.prompt}-${i}`}
                aria-label={`Jadikan pilihan ${i + 1} sebagai kunci jawaban`}
                checked={q.correctAnswer !== "" && opt.trim() !== "" && q.correctAnswer === opt}
                onChange={() => setQ((prev) => ({ ...prev, correctAnswer: opt }))}
              />
              <input
                {...FIELDS.saveQuestion.question.correctAnswer}
                aria-label={`Pilihan jawaban ${i + 1}`}
                className={inputCls}
                value={opt}
                placeholder={`Pilihan ${String.fromCharCode(65 + i)}`}
                onChange={(e) => {
                  const wasCorrect = q.correctAnswer === opt;
                  setOpt(i, e.target.value);
                  if (wasCorrect) setQ((prev) => ({ ...prev, correctAnswer: e.target.value }));
                }}
              />
              {q.options.length > 2 ? (
                <Btn
                  variant="ghost"
                  ariaLabel={`Hapus pilihan ${i + 1}`}
                  onClick={() => setQ((prev) => ({ ...prev, options: prev.options.filter((_, idx) => idx !== i) }))}
                >
                  ✕
                </Btn>
              ) : null}
            </div>
          ))}
          {q.options.length < 6 ? (
            <Btn
              variant="soft"
              ariaLabel="Tambah pilihan jawaban"
              onClick={() => setQ((prev) => ({ ...prev, options: [...prev.options, ""] }))}
            >
              + Pilihan
            </Btn>
          ) : null}
        </div>
      ) : (
        <Field
          label={q.type === "essay" ? "Pedoman jawaban (hanya terlihat guru)" : "Kunci jawaban"}
          hint={q.type === "angka" ? "Tulis angka saja, cth. 42 atau 3.5" : undefined}
        >
          {q.type === "essay" ? (
            <textarea
              {...FIELDS.saveQuestion.question.correctAnswer}
              aria-label="Pedoman jawaban essay"
              className={`${inputCls} min-h-16`}
              value={q.correctAnswer}
              onChange={(e) => setQ((prev) => ({ ...prev, correctAnswer: e.target.value }))}
              placeholder="Poin-poin jawaban ideal untuk pedoman penilaian…"
            />
          ) : (
            <input
              {...FIELDS.saveQuestion.question.correctAnswer}
              aria-label="Kunci jawaban"
              className={inputCls}
              value={q.correctAnswer}
              onChange={(e) => setQ((prev) => ({ ...prev, correctAnswer: e.target.value }))}
            />
          )}
        </Field>
      )}
      {localError || error ? (
        <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
          {localError || error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Btn disabled={busy} submit ariaLabel="Simpan soal">
          {busy ? "Menyimpan…" : "Simpan Soal"}
        </Btn>
        {onCancel ? (
          <Btn variant="ghost" onClick={onCancel} ariaLabel="Batal mengedit soal">
            Batal
          </Btn>
        ) : null}
      </div>
    </form>
  );
}

function ExamEditor({ session, exam, onBack }: { session: Session; exam: ExamT; onBack: () => void }) {
  const qc = useQueryClient();
  const [settings, setSettings] = useState({
    title: exam.title,
    description: exam.description,
    subject: exam.subject,
    kelas: exam.kelas,
    durationMinutes: exam.durationMinutes,
    shuffleQuestions: exam.shuffleQuestions,
    shuffleOptions: exam.shuffleOptions,
    requireExamKey: exam.requireExamKey,
    isPublished: exam.isPublished,
  });
  const [settingsMsg, setSettingsMsg] = useState("");
  const [editingQ, setEditingQ] = useState<QuestionT | null>(null);
  const [createMode, setCreateMode] = useState<"manual" | "ai">("manual");
  const [manualReset, setManualReset] = useState(0);
  const [manualMsg, setManualMsg] = useState("");
  const [qError, setQError] = useState("");
  const [aiMaterial, setAiMaterial] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [aiType, setAiType] = useState<DraftQ["type"]>("pilihan_ganda");
  const [aiDrafts, setAiDrafts] = useState<DraftQ[] | null>(null);
  const [aiError, setAiError] = useState("");
  const [keyCount, setKeyCount] = useState(10);
  const [confirmDeleteExam, setConfirmDeleteExam] = useState(false);

  const questions = useQuery({
    queryKey: ["questions", exam.id],
    queryFn: () => api.listQuestions({ actorId: session.id, examId: exam.id }),
  });
  const examKeys = useQuery({
    queryKey: ["exam-keys", exam.id],
    queryFn: () => api.listExamKeys({ actorId: session.id, examId: exam.id }),
  });

  const invalidateExam = () => {
    qc.invalidateQueries({ queryKey: ["exams"] });
    qc.invalidateQueries({ queryKey: ["questions", exam.id] });
    qc.invalidateQueries({ queryKey: ["exam-keys", exam.id] });
  };

  const saveSettings = useMutation({
    mutationFn: () => api.updateExam({ actorId: session.id, examId: exam.id, ...settings }),
    onSuccess: () => {
      setSettingsMsg("Pengaturan paket tersimpan.");
      invalidateExam();
    },
    onError: (e) => setSettingsMsg(e instanceof Error ? e.message : "Gagal menyimpan."),
  });
  const saveQ = useMutation({
    mutationFn: (q: DraftQ) =>
      api.saveQuestion({
        actorId: session.id,
        examId: exam.id,
        questionId: editingQ ? editingQ.id : null,
        question: q,
      }),
    onSuccess: () => {
      if (editingQ) {
        setEditingQ(null);
      } else {
        // Mode manual: kosongkan formulir agar guru bisa langsung mengisi soal berikutnya.
        setManualReset((r) => r + 1);
        setManualMsg("Soal tersimpan ke paket. Formulir sudah kosong — silakan isi soal berikutnya.");
      }
      setQError("");
      invalidateExam();
    },
    onError: (e) => setQError(e instanceof Error ? e.message : "Gagal menyimpan soal."),
  });
  const delQ = useMutation({
    mutationFn: (questionId: number) => api.deleteQuestion({ actorId: session.id, questionId }),
    onSuccess: invalidateExam,
  });
  const genAI = useMutation({
    mutationFn: () =>
      api.generateQuestionsAI({
        actorId: session.id,
        material: aiMaterial.trim(),
        count: aiCount,
        type: aiType,
        subject: settings.subject,
      }),
    // Layanan AI sesekali sibuk sesaat: coba ulang sekali otomatis sebelum
    // menyerah, supaya guru tidak perlu menekan tombol berkali-kali.
    retry: 1,
    retryDelay: 5000,
    onSuccess: (res) => {
      setAiDrafts(res.questions);
      setAiError("");
    },
    onError: (e) => {
      const raw = e instanceof Error ? e.message : "";
      // Pesan mentah "The app is busy right now…" dari layanan tidak boleh
      // tampil apa adanya — terjemahkan menjadi arahan yang jelas.
      setAiError(
        /busy|please try again|overload|rate.?limit/i.test(raw)
          ? "Layanan AI sedang sibuk saat ini. Tunggu ±30 detik, lalu tekan tombol Buat Soal dengan AI lagi — materi Anda tidak hilang."
          : raw || "AI gagal membuat soal. Coba lagi.",
      );
    },
  });
  const saveBulk = useMutation({
    mutationFn: (qs: DraftQ[]) => api.saveQuestionsBulk({ actorId: session.id, examId: exam.id, questions: qs }),
    onSuccess: () => {
      setAiDrafts(null);
      setAiMaterial("");
      invalidateExam();
    },
    onError: (e) => setAiError(e instanceof Error ? e.message : "Gagal menyimpan soal AI."),
  });
  const makeKeys = useMutation({
    mutationFn: () => api.createExamKeys({ actorId: session.id, examId: exam.id, count: keyCount }),
    onSuccess: invalidateExam,
    onError: (e) => setSettingsMsg(e instanceof Error ? e.message : "Gagal membuat Key ujian."),
  });
  const delExam = useMutation({
    mutationFn: () => api.deleteExam({ actorId: session.id, examId: exam.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exams"] });
      onBack();
    },
  });

  const qList = questions.data?.questions ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Btn variant="ghost" onClick={onBack} ariaLabel="Kembali ke daftar paket soal">
          ← Paket Soal
        </Btn>
        <div>
          <h2 className="text-xl font-extrabold text-[var(--text)]">{exam.title}</h2>
          <p className="text-xs text-[var(--dim)]">
            {qList.length} soal · total {qList.reduce((s, q) => s + q.points, 0)} poin · {exam.durationMinutes} menit ·{" "}
            {exam.isPublished ? "Terbit" : "Draf"}
          </p>
        </div>
      </div>

      <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
        <SectionTitle icon="sliders">Pengaturan Ujian</SectionTitle>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveSettings.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Judul ujian">
              <input
                {...FIELDS.updateExam.title}
                aria-label="Judul ujian"
                className={inputCls}
                value={settings.title}
                onChange={(e) => setSettings((p) => ({ ...p, title: e.target.value }))}
              />
            </Field>
            <Field label="Materi pelajaran">
              <input
                {...FIELDS.updateExam.subject}
                aria-label="Materi pelajaran"
                className={inputCls}
                value={settings.subject}
                onChange={(e) => setSettings((p) => ({ ...p, subject: e.target.value }))}
              />
            </Field>
            <Field label="Kelas">
              <input
                {...FIELDS.updateExam.kelas}
                aria-label="Kelas ujian"
                className={inputCls}
                placeholder="cth. 9A / X RPL 1"
                value={settings.kelas}
                onChange={(e) => setSettings((p) => ({ ...p, kelas: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Deskripsi ujian">
            <textarea
              {...FIELDS.updateExam.description}
              aria-label="Deskripsi ujian"
              className={`${inputCls} min-h-16`}
              value={settings.description}
              onChange={(e) => setSettings((p) => ({ ...p, description: e.target.value }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Durasi (menit)">
              <input
                {...FIELDS.updateExam.durationMinutes}
                aria-label="Durasi ujian dalam menit"
                type="number"
                className={inputCls}
                value={settings.durationMinutes}
                onChange={(e) => setSettings((p) => ({ ...p, durationMinutes: Number(e.target.value) || 60 }))}
              />
            </Field>
            <div className="space-y-2 pt-1">
              {(
                [
                  ["shuffleQuestions", "Acak urutan soal"],
                  ["shuffleOptions", "Acak pilihan jawaban"],
                  ["requireExamKey", "Wajib Key ujian sekali pakai"],
                  ["isPublished", "Terbitkan untuk siswa"],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm font-semibold text-[var(--text)]">
                  <input
                    type="checkbox"
                    aria-label={label}
                    checked={settings[field]}
                    onChange={(e) => setSettings((p) => ({ ...p, [field]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          {settingsMsg ? <p className="text-sm font-semibold text-[var(--accent)]">{settingsMsg}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Btn disabled={saveSettings.isPending} submit ariaLabel="Simpan pengaturan ujian">
              {saveSettings.isPending ? "Menyimpan…" : "Simpan Pengaturan"}
            </Btn>
            <Btn variant="danger" onClick={() => setConfirmDeleteExam(true)} ariaLabel="Hapus paket soal ini">
              Hapus Paket
            </Btn>
          </div>
        </form>
        {confirmDeleteExam ? (
          <div className="mt-3">
            <ConfirmBar
              message="Hapus paket ini beserta semua soal, Key ujian, dan hasil siswa?"
              confirmLabel="Ya, Hapus Paket"
              busy={delExam.isPending}
              onConfirm={() => delExam.mutate()}
              onCancel={() => setConfirmDeleteExam(false)}
            />
          </div>
        ) : null}
      </section>

      <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
        <SectionTitle icon="pen">Buat Soal</SectionTitle>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
          Dua cara mengisi paket ini: tulis soal sendiri satu per satu, atau biarkan AI menyusun
          draf dari materi pelajaran. Draf AI selalu bisa Anda periksa & edit sebelum disimpan.
        </p>
        <div
          className="mt-4 grid grid-cols-2 gap-1.5 rounded-2xl bg-[var(--surface2)] p-1.5"
          role="tablist"
          aria-label="Cara membuat soal"
        >
          <button
            type="button"
            role="tab"
            aria-selected={createMode === "manual"}
            onClick={() => setCreateMode("manual")}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-bold transition ${
              createMode === "manual"
                ? "bg-[var(--surface)] text-[var(--accent)] shadow-card ring-1 ring-[var(--border)]"
                : "text-[var(--dim)] hover:text-[var(--text)]"
            }`}
          >
            <Icon name="pen" size={17} />
            Tulis Sendiri
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={createMode === "ai"}
            onClick={() => setCreateMode("ai")}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-bold transition ${
              createMode === "ai"
                ? "bg-[var(--amber)] text-[#231600] shadow-card"
                : "text-[var(--dim)] hover:text-[var(--text)]"
            }`}
          >
            <Icon name="sparkles" size={17} />
            Dibantu AI
          </button>
        </div>

        {createMode === "manual" ? (
          <div className="mt-4">
            <QuestionForm
              key={manualReset}
              initial={{ type: "pilihan_ganda", prompt: "", options: ["", "", "", ""], correctAnswer: "", points: 10 }}
              busy={saveQ.isPending}
              error={qError}
              onSave={(draft) => {
                setManualMsg("");
                saveQ.mutate(draft);
              }}
            />
            {manualMsg ? (
              <p className="mt-3 flex items-center gap-2 rounded-xl bg-[var(--accent-soft)] px-3 py-2 text-sm font-semibold text-[var(--accent)]">
                <Icon name="checkCircle" size={16} />
                {manualMsg}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl bg-[var(--amber-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--text)]">
              <span className="font-bold">Cara kerja:</span> tempel materi pelajaran, tentukan jumlah
              & jenis soal — AI menyusun pertanyaan, pilihan jawaban, dan kunci jawabannya untuk Anda.
              Poin tiap soal otomatis dibagi rata agar total nilainya tepat <span className="font-bold">100</span>,
              jadi nilai siswa tampil sebagai nilai yang didapat / 100.
            </div>
            <Field label="Materi pelajaran">
              <textarea
                {...FIELDS.generateQuestionsAI.material}
                aria-label="Materi pelajaran untuk AI"
                className={`${inputCls} min-h-28`}
                placeholder="Tempel teks materi di sini (minimal beberapa kalimat)…"
                value={aiMaterial}
                onChange={(e) => setAiMaterial(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Jumlah soal">
                <input
                  {...FIELDS.generateQuestionsAI.count}
                  aria-label="Jumlah soal AI"
                  type="number"
                  className={inputCls}
                  value={aiCount}
                  onChange={(e) => setAiCount(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                />
              </Field>
              <Field label="Jenis soal">
                <select
                  aria-label="Jenis soal AI"
                  className={inputCls}
                  value={aiType}
                  onChange={(e) => setAiType(e.target.value as DraftQ["type"])}
                >
                  <option value="pilihan_ganda">Pilihan Ganda</option>
                  <option value="isian">Isian Singkat</option>
                  <option value="essay">Essay</option>
                  <option value="angka">Jawaban Angka</option>
                </select>
              </Field>
            </div>
            {aiError ? (
              <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                {aiError}
              </p>
            ) : null}
            <Btn
              variant="amber"
              disabled={genAI.isPending}
              onClick={() => {
                if (aiMaterial.trim().length < 10) {
                  setAiError(
                    "Materi masih terlalu singkat. Tulis topik beserta beberapa kalimat penjelasan (minimal ±10 karakter), lalu ketuk tombol ini lagi.",
                  );
                  return;
                }
                setAiError("");
                genAI.mutate();
              }}
              ariaLabel="Buat soal dengan AI"
            >
              <Icon name="sparkles" size={17} />
              {genAI.isPending ? "AI sedang menyusun soal…" : "Buat Soal dengan AI"}
            </Btn>
            {genAI.isPending ? (
              <p className="text-xs text-[var(--dim)]">
                AI sedang membaca materi dan menyusun soal — biasanya 10–40 detik. Jangan tutup halaman ini.
              </p>
            ) : (
              <p className="text-xs text-[var(--dim)]">
                Tombol aktif begitu materi terisi (judul topik + beberapa kalimat sudah cukup).
              </p>
            )}
          </div>
        )}

        {aiDrafts ? (
          <div className="mt-5 space-y-3 border-t border-[var(--border)] pt-4">
            <h4 className="flex items-center gap-2 font-extrabold text-[var(--text)]">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--amber-soft)] text-[var(--amber)]">
                <Icon name="sparkles" size={17} />
              </span>
              Draf AI — periksa & edit dulu ({aiDrafts.length} soal)
            </h4>
            <p className="text-sm leading-relaxed text-[var(--dim)]">
              Total nilai draf ini{" "}
              <span className="font-bold text-[var(--text)]">{aiDrafts.reduce((s, d) => s + d.points, 0)} / 100</span>{" "}
              — poin tiap soal diatur otomatis agar totalnya tepat 100. Kalau ada draf yang dibuang,
              poin soal sisanya dibagi ulang otomatis.
            </p>
            {aiDrafts.map((d, i) => (
              <div key={i} className="space-y-2 rounded-2xl border border-[var(--border)] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                  Draf {i + 1} · {TYPE_LABEL[d.type]} · {d.points} poin
                </p>
                <textarea
                  aria-label={`Pertanyaan draf AI ${i + 1}`}
                  className={`${inputCls} min-h-14`}
                  value={d.prompt}
                  onChange={(e) =>
                    setAiDrafts((prev) => (prev ? prev.map((x, xi) => (xi === i ? { ...x, prompt: e.target.value } : x)) : prev))
                  }
                />
                {d.type === "pilihan_ganda"
                  ? d.options.map((o, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`ai-correct-${i}`}
                          aria-label={`Kunci draf ${i + 1} pilihan ${oi + 1}`}
                          checked={d.correctAnswer === o && o !== ""}
                          onChange={() =>
                            setAiDrafts((prev) => (prev ? prev.map((x, xi) => (xi === i ? { ...x, correctAnswer: o } : x)) : prev))
                          }
                        />
                        <input
                          aria-label={`Draf ${i + 1} pilihan ${oi + 1}`}
                          className={inputCls}
                          value={o}
                          onChange={(e) =>
                            setAiDrafts((prev) =>
                              prev
                                ? prev.map((x, xi) =>
                                    xi === i
                                      ? {
                                          ...x,
                                          options: x.options.map((oo, ooi) => (ooi === oi ? e.target.value : oo)),
                                          correctAnswer: x.correctAnswer === o ? e.target.value : x.correctAnswer,
                                        }
                                      : x,
                                  )
                                : prev,
                            )
                          }
                        />
                      </div>
                    ))
                  : null}
                {d.type !== "pilihan_ganda" ? (
                  <input
                    aria-label={`Kunci jawaban draf AI ${i + 1}`}
                    className={inputCls}
                    value={d.correctAnswer}
                    placeholder={d.type === "essay" ? "Pedoman jawaban" : "Kunci jawaban"}
                    onChange={(e) =>
                      setAiDrafts((prev) => (prev ? prev.map((x, xi) => (xi === i ? { ...x, correctAnswer: e.target.value } : x)) : prev))
                    }
                  />
                ) : null}
                <Btn
                  variant="ghost"
                  ariaLabel={`Buang draf AI ${i + 1}`}
                  onClick={() =>
                    setAiDrafts((prev) => (prev ? rebalanceDraftPoints(prev.filter((_, xi) => xi !== i)) : prev))
                  }
                >
                  Buang Draf Ini
                </Btn>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Btn
                disabled={saveBulk.isPending || aiDrafts.length === 0}
                onClick={() => saveBulk.mutate(aiDrafts)}
                ariaLabel="Simpan semua draf AI ke paket soal"
              >
                {saveBulk.isPending ? "Menyimpan…" : `Simpan ${aiDrafts.length} Soal ke Paket`}
              </Btn>
              <Btn variant="ghost" onClick={() => setAiDrafts(null)} ariaLabel="Tutup draf AI">
                Tutup
              </Btn>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
        <SectionTitle icon="fileText">Daftar Soal ({qList.length})</SectionTitle>
        <div className="mt-3 space-y-3">
          {questions.isPending ? <p className="text-sm text-[var(--dim)]">Memuat soal…</p> : null}
          {qList.length === 0 && !questions.isPending ? (
            <p className="text-sm text-[var(--dim)]">
              Belum ada soal. Isi lewat panel Buat Soal di atas — tulis sendiri atau dibantu AI.
            </p>
          ) : null}
          {qList.map((q, i) => (
            <article key={q.id} className="rounded-2xl border border-[var(--border)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                  {i + 1}. {TYPE_LABEL[q.type]} · {q.points} poin
                </p>
                <div className="flex gap-2">
                  <Btn variant="soft" onClick={() => setEditingQ(q)} ariaLabel={`Edit soal ${i + 1}`}>
                    Edit
                  </Btn>
                  <Btn variant="ghost" onClick={() => delQ.mutate(q.id)} ariaLabel={`Hapus soal ${i + 1}`}>
                    Hapus
                  </Btn>
                </div>
              </div>
              <p className="mt-1.5 font-semibold text-[var(--text)]">{q.prompt}</p>
              {q.options.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm text-[var(--dim)]">
                  {q.options.map((o, oi) => (
                    <li key={oi} className={o === q.correctAnswer ? "font-bold text-[var(--accent)]" : ""}>
                      {String.fromCharCode(65 + oi)}. {o} {o === q.correctAnswer ? "✓ kunci" : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  {q.type === "essay" ? "Pedoman: " : "Kunci: "}
                  <span className="font-semibold text-[var(--text)]">{q.correctAnswer || "—"}</span>
                </p>
              )}
              {editingQ?.id === q.id ? (
                <div className="mt-3">
                  <QuestionForm
                    initial={{ type: q.type, prompt: q.prompt, options: q.options.length ? q.options : ["", "", "", ""], correctAnswer: q.correctAnswer, points: q.points }}
                    busy={saveQ.isPending}
                    error={qError}
                    onSave={(draft) => saveQ.mutate(draft)}
                    onCancel={() => setEditingQ(null)}
                  />
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
        <SectionTitle icon="key">Key Ujian Sekali Pakai</SectionTitle>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Aktif bila pengaturan “Wajib Key ujian” menyala. Setiap Key hanya bisa dipakai satu siswa untuk memulai ujian ini.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Jumlah Key">
            <input
              {...FIELDS.createExamKeys.count}
              aria-label="Jumlah Key ujian yang dibuat"
              type="number"
              className={`${inputCls} w-28`}
              value={keyCount}
              onChange={(e) => setKeyCount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
            />
          </Field>
          <Btn onClick={() => makeKeys.mutate()} disabled={makeKeys.isPending} ariaLabel="Buat Key ujian">
            {makeKeys.isPending ? "Membuat…" : "Buat Key Ujian"}
          </Btn>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(examKeys.data?.keys ?? []).map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded-xl bg-[var(--surface2)] px-3 py-2">
              <span className="font-bold tracking-wider text-[var(--text)]">{k.code}</span>
              {k.isUsed ? (
                <Badge tone="red">Terpakai · {k.usedByName ?? ""}</Badge>
              ) : (
                <Badge tone="green">Belum dipakai</Badge>
              )}
            </div>
          ))}
          {(examKeys.data?.keys ?? []).length === 0 ? (
            <p className="text-sm text-[var(--dim)]">Belum ada Key ujian untuk paket ini.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ---------- Teacher dashboard ----------

function TeacherView({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState("beranda");
  const [selectedExam, setSelectedExam] = useState<ExamT | null>(null);
  const [openAttempt, setOpenAttempt] = useState<number | null>(null);
  const [newExam, setNewExam] = useState({
    title: "",
    subject: "",
    kelas: "",
    description: "",
    durationMinutes: 60,
    shuffleQuestions: true,
    shuffleOptions: true,
    requireExamKey: false,
  });
  const [examError, setExamError] = useState("");

  const stats = useQuery({
    queryKey: ["teacher-stats", session.id],
    queryFn: () => api.teacherStats({ actorId: session.id }),
  });
  const exams = useQuery({
    queryKey: ["exams", session.id],
    queryFn: () => api.listExams({ actorId: session.id }),
  });
  const createExam = useMutation({
    mutationFn: () => api.createExam({ actorId: session.id, ...newExam }),
    onSuccess: (res) => {
      setNewExam({ title: "", subject: "", kelas: "", description: "", durationMinutes: 60, shuffleQuestions: true, shuffleOptions: true, requireExamKey: false });
      qc.invalidateQueries({ queryKey: ["exams"] });
      setSelectedExam(res.exam);
    },
    onError: (e) => setExamError(e instanceof Error ? e.message : "Gagal membuat paket soal."),
  });

  if (openAttempt != null) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar session={session} onLogout={onLogout} />
        <main className="mx-auto max-w-5xl px-4 py-5">
          <AttemptDetailView session={session} attemptId={openAttempt} onBack={() => setOpenAttempt(null)} />
        </main>
      </div>
    );
  }
  if (selectedExam) {
    const fresh = (exams.data?.exams ?? []).find((e) => e.id === selectedExam.id) ?? selectedExam;
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar session={session} onLogout={onLogout} />
        <main className="mx-auto max-w-5xl px-4 py-5">
          <ExamEditor session={session} exam={fresh} onBack={() => setSelectedExam(null)} />
        </main>
      </div>
    );
  }

  const examList = exams.data?.exams ?? [];
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar session={session} onLogout={onLogout} />
      <div className="mx-auto flex w-full max-w-7xl items-start gap-6 px-4 py-5 pb-28 lg:pb-8">
        <TabBar
          tabs={[
            { id: "beranda", label: "Beranda", icon: "home" },
            { id: "paket", label: "Paket Soal", icon: "layers", shortLabel: "Paket" },
            { id: "peserta", label: "Peserta", icon: "users" },
            { id: "hasil", label: "Hasil", icon: "inbox" },
          ]}
          active={tab}
          onChange={setTab}
        />
        <main className="min-w-0 flex-1 space-y-5">

        {tab === "beranda" ? (
          <div className="space-y-5">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-deep)] p-5 text-[var(--accent-ink)] shadow-card">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-[0.12]"
                style={{
                  backgroundImage: "radial-gradient(rgb(255 255 255) 1.2px, transparent 1.2px)",
                  backgroundSize: "18px 18px",
                }}
              />
              <div className="relative flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-extrabold tracking-tight">Halo, {session.name}</h2>
                  <p className="mt-1 text-sm font-medium opacity-90">
                    Kelola paket soal, peserta, dan hasil ujian dari sini.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setTab("paket")}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/15 px-4 py-2 text-sm font-bold ring-1 ring-white/30 transition hover:bg-white/25"
                  aria-label="Buat paket soal baru"
                >
                  <Icon name="plus" size={16} />
                  Paket Soal Baru
                </button>
              </div>
            </div>
            <InstallAppCard compact />
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Paket Soal" value={stats.data?.examCount ?? "…"} icon="layers" />
              <StatCard label="Peserta" value={stats.data?.studentCount ?? "…"} icon="users" />
              <StatCard label="Ujian Selesai" value={stats.data?.finishedCount ?? "…"} icon="checkCircle" tint="amber" />
            </div>
            <section className="space-y-3">
              <h3 className="font-extrabold text-[var(--text)]">Hasil Terbaru</h3>
              {(stats.data?.recent ?? []).length === 0 ? (
                <p className="rounded-2xl bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
                  Belum ada hasil masuk. Buat paket soal, terbitkan, lalu bagikan Key siswa & Key ujian.
                </p>
              ) : (
                (stats.data?.recent ?? []).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setOpenAttempt(a.id)}
                    aria-label={`Lihat hasil ${a.studentName}`}
                    className="block w-full rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left shadow-card"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-extrabold text-[var(--text)]">{a.studentName}</p>
                        <p className="text-sm text-[var(--dim)]">
                          {a.examTitle} · {fmtDate(a.submittedAt ?? a.startedAt)}
                        </p>
                      </div>
                      <Badge tone={a.status === "graded" ? "green" : a.status === "submitted" ? "amber" : "soft"}>
                        {a.status === "graded" ? `${a.totalScore ?? 0}/${a.maxScore}` : a.status === "submitted" ? "Perlu dinilai" : "Berlangsung"}
                      </Badge>
                    </div>
                  </button>
                ))
              )}
            </section>
          </div>
        ) : null}

        {tab === "paket" ? (
          <div className="space-y-5">
            <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
              <SectionTitle icon="layers">Buat Paket Soal Baru</SectionTitle>
              <form
                className="mt-3 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newExam.title.trim()) {
                    setExamError("Judul ujian tidak boleh kosong.");
                    return;
                  }
                  setExamError("");
                  createExam.mutate();
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Judul ujian">
                    <input
                      {...FIELDS.createExam.title}
                      aria-label="Judul ujian baru"
                      className={inputCls}
                      placeholder="cth. UTS Matematika Bab 3"
                      value={newExam.title}
                      onChange={(e) => setNewExam((p) => ({ ...p, title: e.target.value }))}
                    />
                  </Field>
                  <Field label="Materi pelajaran">
                    <input
                      {...FIELDS.createExam.subject}
                      aria-label="Materi pelajaran paket baru"
                      className={inputCls}
                      placeholder="cth. Aljabar"
                      value={newExam.subject}
                      onChange={(e) => setNewExam((p) => ({ ...p, subject: e.target.value }))}
                    />
                  </Field>
                  <Field label="Kelas">
                    <input
                      {...FIELDS.createExam.kelas}
                      aria-label="Kelas paket baru"
                      className={inputCls}
                      placeholder="cth. 9A / X RPL 1"
                      value={newExam.kelas}
                      onChange={(e) => setNewExam((p) => ({ ...p, kelas: e.target.value }))}
                    />
                  </Field>
                </div>
                <Field label="Deskripsi ujian">
                  <textarea
                    {...FIELDS.createExam.description}
                    aria-label="Deskripsi ujian baru"
                    className={`${inputCls} min-h-14`}
                    value={newExam.description}
                    onChange={(e) => setNewExam((p) => ({ ...p, description: e.target.value }))}
                    placeholder="Petunjuk singkat untuk siswa…"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Durasi (menit)">
                    <input
                      {...FIELDS.createExam.durationMinutes}
                      aria-label="Durasi paket baru dalam menit"
                      type="number"
                      className={inputCls}
                      value={newExam.durationMinutes}
                      onChange={(e) => setNewExam((p) => ({ ...p, durationMinutes: Number(e.target.value) || 60 }))}
                    />
                  </Field>
                  <div className="space-y-2 pt-1">
                    {(
                      [
                        ["shuffleQuestions", "Acak soal"],
                        ["shuffleOptions", "Acak pilihan jawaban"],
                        ["requireExamKey", "Wajib Key ujian"],
                      ] as const
                    ).map(([f, label]) => (
                      <label key={f} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm font-semibold text-[var(--text)]">
                        <input
                          type="checkbox"
                          aria-label={label}
                          checked={newExam[f]}
                          onChange={(e) => setNewExam((p) => ({ ...p, [f]: e.target.checked }))}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                {examError ? (
                  <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                    {examError}
                  </p>
                ) : null}
                <Btn disabled={createExam.isPending} submit ariaLabel="Buat paket soal baru">
                  {createExam.isPending ? "Membuat…" : "Buat Paket & Tambah Soal"}
                </Btn>
              </form>
            </section>

            <section className="space-y-3">
              <h3 className="font-extrabold text-[var(--text)]">Paket Saya ({examList.length})</h3>
              {examList.length === 0 && !exams.isPending ? (
                <p className="rounded-2xl bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">Belum ada paket soal.</p>
              ) : null}
              <div className="grid items-start gap-3 lg:grid-cols-2">
              {examList.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedExam(e)}
                  aria-label={`Buka paket ${e.title}`}
                  className="block w-full rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left shadow-card"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-extrabold text-[var(--text)]">{e.title}</p>
                      <p className="text-sm text-[var(--dim)]">
                        {e.subject || "Tanpa materi"}{e.kelas ? ` · Kelas ${e.kelas}` : ""} · {e.questionCount} soal · {e.durationMinutes} menit
                      </p>
                    </div>
                    <Badge tone={e.isPublished ? "green" : "soft"}>{e.isPublished ? "Terbit" : "Draf"}</Badge>
                  </div>
                </button>
              ))}
              </div>
            </section>
          </div>
        ) : null}

        {tab === "peserta" ? <UserManager session={session} mode="guru" /> : null}
        {tab === "hasil" ? <AttemptsInbox session={session} onOpen={setOpenAttempt} /> : null}
        </main>
      </div>
    </div>
  );
}

// ---------- Admin dashboard ----------

function AdminView({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [tab, setTab] = useState("ringkasan");
  const [openAttempt, setOpenAttempt] = useState<number | null>(null);
  const [schoolName, setSchoolName] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [settingsMsg, setSettingsMsg] = useState("");
  const qc = useQueryClient();

  const stats = useQuery({
    queryKey: ["admin-stats", session.id],
    queryFn: () => api.adminStats({ actorId: session.id }),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({}) });
  const exams = useQuery({
    queryKey: ["exams", session.id],
    queryFn: () => api.listExams({ actorId: session.id }),
    enabled: tab === "paket",
  });
  const saveSettings = useMutation({
    mutationFn: () =>
      api.updateSettings({
        actorId: session.id,
        schoolName: (schoolName ?? settings.data?.schoolName ?? "").trim(),
        announcement: (announcement ?? settings.data?.announcement ?? "").trim(),
      }),
    onSuccess: () => {
      setSettingsMsg("Pengaturan tersimpan.");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => setSettingsMsg(e instanceof Error ? e.message : "Gagal menyimpan pengaturan."),
  });

  if (openAttempt != null) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar session={session} onLogout={onLogout} />
        <main className="mx-auto max-w-5xl px-4 py-5">
          <AttemptDetailView session={session} attemptId={openAttempt} onBack={() => setOpenAttempt(null)} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar session={session} onLogout={onLogout} />
      <div className="mx-auto flex w-full max-w-7xl items-start gap-6 px-4 py-5 pb-28 lg:pb-8">
        <TabBar
          tabs={[
            { id: "ringkasan", label: "Ringkasan", icon: "home" },
            { id: "pengguna", label: "Pengguna", icon: "users" },
            { id: "paket", label: "Paket Soal", icon: "layers", shortLabel: "Paket" },
            { id: "hasil", label: "Hasil", icon: "inbox" },
            { id: "pengaturan", label: "Pengaturan", icon: "sliders", shortLabel: "Atur" },
          ]}
          active={tab}
          onChange={setTab}
        />
        <main className="min-w-0 flex-1 space-y-5">

        {tab === "ringkasan" ? (
          <div className="space-y-5">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-deep)] p-5 text-[var(--accent-ink)] shadow-card">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-[0.12]"
                style={{
                  backgroundImage: "radial-gradient(rgb(255 255 255) 1.2px, transparent 1.2px)",
                  backgroundSize: "18px 18px",
                }}
              />
              <div className="relative">
                <h2 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
                  <Icon name="shield" size={24} />
                  Dashboard Admin
                </h2>
                <p className="mt-1 text-sm font-medium opacity-90">
                  Kendali penuh atas akun, Key, paket soal, dan hasil AD QUEST.
                </p>
              </div>
            </div>
            <InstallAppCard compact />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <StatCard label="Guru" value={stats.data?.teachers ?? "…"} icon="gradCap" />
              <StatCard label="Pengawas" value={stats.data?.supervisors ?? "…"} icon="shield" />
              <StatCard label="Siswa" value={stats.data?.students ?? "…"} icon="users" />
              <StatCard label="Paket Ujian" value={stats.data?.exams ?? "…"} icon="layers" />
              <StatCard label="Total Soal" value={stats.data?.questions ?? "…"} icon="fileText" />
              <StatCard label="Hasil Masuk" value={stats.data?.attempts ?? "…"} icon="inbox" tint="amber" />
              <StatCard label="Akun Terkunci" value={stats.data?.lockedUsers ?? "…"} icon="lock" tint="amber" />
            </div>
          </div>
        ) : null}

        {tab === "pengguna" ? <UserManager session={session} mode="admin" /> : null}

        {tab === "paket" ? (
          <section className="space-y-3">
            <h2 className="text-lg font-extrabold text-[var(--text)]">Seluruh Paket Soal</h2>
            {(exams.data?.exams ?? []).length === 0 && !exams.isPending ? (
              <p className="rounded-2xl bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">Belum ada paket soal dari guru mana pun.</p>
            ) : null}
            <div className="grid items-start gap-3 lg:grid-cols-2">
            {(exams.data?.exams ?? []).map((e) => (
              <article key={e.id} className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-extrabold text-[var(--text)]">{e.title}</p>
                    <p className="text-sm text-[var(--dim)]">
                      Guru: {e.teacherName} · {e.subject || "—"}{e.kelas ? ` · Kelas ${e.kelas}` : ""} · {e.questionCount} soal · {e.durationMinutes} menit
                    </p>
                  </div>
                  <Badge tone={e.isPublished ? "green" : "soft"}>{e.isPublished ? "Terbit" : "Draf"}</Badge>
                </div>
              </article>
            ))}
            </div>
          </section>
        ) : null}

        {tab === "hasil" ? <AttemptsInbox session={session} onOpen={setOpenAttempt} /> : null}

        {tab === "pengaturan" ? (
          <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
            <h2 className="text-lg font-extrabold text-[var(--text)]">Pengaturan Aplikasi</h2>
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveSettings.mutate();
              }}
            >
              <Field label="Nama sekolah">
                <input
                  {...FIELDS.updateSettings.schoolName}
                  aria-label="Nama sekolah"
                  className={inputCls}
                  placeholder="cth. SMP Negeri 1 Denpasar"
                  value={schoolName ?? settings.data?.schoolName ?? ""}
                  onChange={(e) => setSchoolName(e.target.value)}
                />
              </Field>
              <Field label="Pengumuman (tampil di halaman login)">
                <textarea
                  {...FIELDS.updateSettings.announcement}
                  aria-label="Pengumuman aplikasi"
                  className={`${inputCls} min-h-20`}
                  value={announcement ?? settings.data?.announcement ?? ""}
                  onChange={(e) => setAnnouncement(e.target.value)}
                  placeholder="cth. Ujian semester dimulai Senin depan."
                />
              </Field>
              {settingsMsg ? <p className="text-sm font-semibold text-[var(--accent)]">{settingsMsg}</p> : null}
              <Btn disabled={saveSettings.isPending} submit ariaLabel="Simpan pengaturan aplikasi">
                {saveSettings.isPending ? "Menyimpan…" : "Simpan Pengaturan"}
              </Btn>
            </form>
          </section>
        ) : null}
        </main>
      </div>
    </div>
  );
}

// ---------- Student: exam runner ----------

type ExamSession = ApiResponse<typeof api, "startExam">;

function ExamRunner({
  session,
  data,
  onDone,
  onLogout,
}: {
  session: Session;
  data: ExamSession;
  onDone: () => void;
  onLogout: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(data.answers);
  const [current, setCurrent] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  const [saveNote, setSaveNote] = useState("Jawaban tersimpan otomatis");
  const [lockInfo, setLockInfo] = useState<{ reason: string } | null>(null);
  const submittedRef = useRef(false);
  const lockRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useMutation({
    mutationFn: (ans: Record<string, string>) =>
      api.saveAnswers({ actorId: session.id, attemptId: data.attemptId, answers: ans }),
    onSuccess: () => setSaveNote("Jawaban tersimpan otomatis"),
    onError: () => setSaveNote("Gagal menyimpan — periksa koneksi"),
  });
  const submit = useMutation({
    mutationFn: (ans: Record<string, string>) =>
      api.submitExam({ actorId: session.id, attemptId: data.attemptId, answers: ans }),
    onSuccess: () => onDone(),
  });
  const reportLock = useMutation({
    mutationFn: (reason: string) =>
      api.reportViolation({ actorId: session.id, attemptId: data.attemptId, reason }),
  });
  const reportLockRef = useRef(reportLock.mutate);
  reportLockRef.current = reportLock.mutate;

  const remaining = Math.max(0, Math.floor((data.deadlineMs - now) / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (remaining <= 0 && !submittedRef.current && !lockRef.current) {
      submittedRef.current = true;
      submit.mutate(answers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  // Anti-keluar aplikasi: membuka aplikasi lain (termasuk aplikasi mengambang),
  // keluar dari halaman ujian, atau membuka asisten (mis. Gemini lewat tombol
  // daya ditekan lama) membuat halaman kehilangan fokus / tersembunyi.
  // Sekali terdeteksi: layar langsung terkunci di klien dan server mengunci
  // akun + ujian. Hanya pengawas/guru/admin yang bisa membuka kunci.
  useEffect(() => {
    const trigger = (reason: string) => {
      if (lockRef.current || submittedRef.current) return;
      lockRef.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setLockInfo({ reason });
      reportLockRef.current(reason);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        trigger("Membuka aplikasi lain / keluar dari halaman ujian");
      }
    };
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        if (!document.hasFocus()) {
          trigger("Keluar dari aplikasi ujian / membuka aplikasi lain");
        }
      }, 1200);
    };
    const onFocus = () => {
      if (blurTimer) clearTimeout(blurTimer);
    };
    const onPageHide = () => trigger("Keluar dari aplikasi ujian");
    const onContextMenu = (e: Event) => e.preventDefault();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("contextmenu", onContextMenu);
      if (blurTimer) clearTimeout(blurTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAnswer = (qid: number, value: string) => {
    const next = { ...answers, [String(qid)]: value };
    setAnswers(next);
    setSaveNote("Menyimpan…");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save.mutate(next), 700);
  };

  const total = data.questions.length;
  const answeredCount = data.questions.filter((q) => (answers[String(q.id)] ?? "").trim() !== "").length;
  const q = data.questions[current];
  const urgent = remaining <= 300;

  if (lockInfo) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar session={session} onLogout={() => undefined} hideLogout />
        <main className="mx-auto flex max-w-md flex-col items-center px-5 py-16 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--danger)] text-white shadow-pop">
            <Icon name="lock" size={36} />
          </div>
          <h2 className="mt-5 text-2xl font-extrabold text-[var(--text)]">Layar Ujian Terkunci</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            Terdeteksi: <span className="font-bold text-[var(--text)]">{lockInfo.reason}</span>.
            Akun Anda otomatis dikunci dan ujian tidak dapat dilanjutkan.
          </p>
          <div className="mt-5 w-full rounded-2xl border border-[var(--amber)] bg-[var(--surface)] p-4 text-left">
            <p className="text-sm font-bold text-[var(--text)]">Cara membuka kunci</p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              Minta bantuan <span className="font-bold text-[var(--text)]">pengawas</span> (atau guru Anda)
              untuk membuka kunci akun Anda dari panel pantauan pengawas. Setelah dibuka, masuk kembali
              dengan Key Anda dan lanjutkan ujian — jawaban yang sudah terisi tetap tersimpan.
            </p>
          </div>
          <Btn className="mt-6" onClick={onLogout} ariaLabel="Keluar dan masuk lagi setelah kunci dibuka">
            Keluar — Masuk Lagi Setelah Dibuka
          </Btn>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar session={session} onLogout={() => undefined} hideLogout />
      <div className="sticky top-[68px] z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-[var(--text)]">{data.examTitle}</p>
            <p className="text-xs text-[var(--dim)]">{saveNote}</p>
          </div>
          <div
            aria-label={`Sisa waktu ${fmtClock(remaining)}`}
            className={`rounded-xl px-3.5 py-2 text-lg font-extrabold tabular-nums ${
              urgent ? "bg-[var(--danger)] text-white" : "bg-[var(--amber)] text-[#231600]"
            }`}
          >
            {fmtClock(remaining)}
          </div>
        </div>
        <div className="h-2 bg-[var(--surface2)]" role="progressbar" aria-valuenow={answeredCount} aria-valuemin={0} aria-valuemax={total} aria-label="Kemajuan pengerjaan">
          <div
            className="h-full bg-[var(--accent)] transition-all"
            style={{ width: `${total ? (answeredCount / total) * 100 : 0}%` }}
          />
        </div>
      </div>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5 pb-40">
        <nav aria-label="Nomor soal" className="flex flex-wrap gap-1.5">
          {data.questions.map((qq, i) => {
            const done = (answers[String(qq.id)] ?? "").trim() !== "";
            return (
              <button
                key={qq.id}
                type="button"
                onClick={() => setCurrent(i)}
                aria-label={`Soal ${i + 1}${done ? " (sudah dijawab)" : ""}`}
                aria-current={i === current ? "true" : undefined}
                className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-extrabold ${
                  i === current
                    ? "bg-[var(--accent)] text-[var(--accent-ink)] ring-2 ring-[var(--amber)]"
                    : done
                      ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                      : "bg-[var(--surface)] text-[var(--dim)] border border-[var(--border)]"
                }`}
              >
                {i + 1}
              </button>
            );
          })}
        </nav>

        {q ? (
          <article className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                Soal {current + 1} dari {total} · {TYPE_LABEL[q.type]}
              </p>
              <Badge>{q.points} poin</Badge>
            </div>
            <h2 className="mt-3 text-lg font-bold leading-relaxed text-[var(--text)]">{q.prompt}</h2>

            <div className="mt-4">
              {q.type === "pilihan_ganda" ? (
                <div className="space-y-2.5" role="radiogroup" aria-label="Pilihan jawaban">
                  {q.options.map((opt, oi) => {
                    const selected = answers[String(q.id)] === opt;
                    return (
                      <button
                        key={oi}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setAnswer(q.id, opt)}
                        className={`flex w-full items-center gap-3 rounded-2xl border-2 p-4 text-left text-base font-semibold transition active:scale-[0.99] ${
                          selected
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)] shadow-card"
                            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-[var(--accent)]/50"
                        }`}
                      >
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold ${
                            selected ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface2)] text-[var(--dim)]"
                          }`}
                        >
                          {String.fromCharCode(65 + oi)}
                        </span>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              ) : q.type === "essay" ? (
                <textarea
                  aria-label="Jawaban essay"
                  className={`${inputCls} min-h-36`}
                  placeholder="Tulis jawaban essay Anda di sini…"
                  value={answers[String(q.id)] ?? ""}
                  onChange={(e) => setAnswer(q.id, e.target.value)}
                />
              ) : (
                <input
                  aria-label={q.type === "angka" ? "Jawaban angka" : "Jawaban isian singkat"}
                  type={q.type === "angka" ? "number" : "text"}
                  inputMode={q.type === "angka" ? "decimal" : undefined}
                  className={inputCls}
                  placeholder={q.type === "angka" ? "Tulis angka jawaban…" : "Tulis jawaban singkat…"}
                  value={answers[String(q.id)] ?? ""}
                  onChange={(e) => setAnswer(q.id, e.target.value)}
                />
              )}
            </div>
          </article>
        ) : null}

        {confirming ? (
          <ConfirmBar
            message={`Kumpulkan sekarang? Terjawab ${answeredCount} dari ${total} soal. Setelah terkumpul, jawaban tidak bisa diubah.`}
            confirmLabel="Ya, Kumpulkan"
            busy={submit.isPending}
            onConfirm={() => {
              if (!submittedRef.current) {
                submittedRef.current = true;
                submit.mutate(answers);
              }
            }}
            onCancel={() => setConfirming(false)}
          />
        ) : null}
        {submit.isError ? (
          <p role="alert" className="rounded-2xl bg-[var(--danger)]/10 p-4 text-sm font-semibold text-[var(--danger)]">
            Gagal mengumpulkan. Coba lagi — jawaban Anda tetap tersimpan.
          </p>
        ) : null}
      </main>

      <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--surface)] pb-safe">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3">
          <Btn
            variant="ghost"
            disabled={current === 0}
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            ariaLabel="Soal sebelumnya"
          >
            ← Sebelumnya
          </Btn>
          {current < total - 1 ? (
            <Btn
              className="flex-1"
              onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
              ariaLabel="Soal berikutnya"
            >
              Berikutnya →
            </Btn>
          ) : (
            <Btn
              variant="amber"
              className="flex-1"
              onClick={() => setConfirming(true)}
              ariaLabel="Kumpulkan jawaban ujian"
            >
              Kumpulkan Jawaban ({answeredCount}/{total})
            </Btn>
          )}
        </div>
      </footer>
    </div>
  );
}

// ---------- Student dashboard ----------

function StudentView({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [running, setRunning] = useState<ExamSession | null>(null);
  const [done, setDone] = useState(false);
  const [keyInputs, setKeyInputs] = useState<Record<number, string>>({});
  const [startError, setStartError] = useState<Record<number, string>>({});
  // Key ujian yang sudah lolos pemeriksaan per ujian (kode ternormalisasi).
  // Selama Key belum diperiksa, tombol "Siap Memulai Ujian" belum muncul;
  // Key baru benar-benar terpakai saat tombol itu ditekan.
  const [keyReady, setKeyReady] = useState<Record<number, string>>({});
  const [keyCheckError, setKeyCheckError] = useState<Record<number, string>>({});

  const home = useQuery({
    queryKey: ["student-home", session.id],
    queryFn: () => api.studentHome({ actorId: session.id }),
    enabled: !running && !done,
  });
  const start = useMutation({
    mutationFn: (v: { examId: number; code: string }) =>
      api.startExam({ actorId: session.id, examId: v.examId, examKeyCode: v.code }),
    onSuccess: (res) => setRunning(res),
    onError: (e, v) =>
      setStartError((prev) => ({
        ...prev,
        [v.examId]: e instanceof Error ? e.message : "Gagal memulai ujian.",
      })),
  });
  const checkKey = useMutation({
    mutationFn: (v: { examId: number; code: string }) =>
      api.checkExamKey({ actorId: session.id, examId: v.examId, examKeyCode: v.code }),
    onSuccess: (_res, v) => {
      setKeyReady((p) => ({ ...p, [v.examId]: v.code.trim().toUpperCase() }));
      setKeyCheckError((p) => ({ ...p, [v.examId]: "" }));
      setStartError((p) => ({ ...p, [v.examId]: "" }));
    },
    onError: (e, v) =>
      setKeyCheckError((p) => ({
        ...p,
        [v.examId]: e instanceof Error ? e.message : "Key ujian tidak valid.",
      })),
  });

  if (running) {
    return (
      <ExamRunner
        session={session}
        data={running}
        onDone={() => { setRunning(null); setDone(true); }}
        onLogout={onLogout}
      />
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar session={session} onLogout={onLogout} />
        <main className="mx-auto flex max-w-md flex-col items-center px-5 py-16 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent)] text-3xl font-extrabold text-[var(--accent-ink)]">
            ✓
          </div>
          <h2 className="mt-5 text-2xl font-extrabold text-[var(--text)]">Selamat, {session.name}!</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            Anda berhasil menyelesaikan ujian. Jawaban sudah terkirim ke guru Anda.
            Hasil dan nilai akan disampaikan langsung oleh guru.
          </p>
          <Btn className="mt-6" onClick={() => setDone(false)} ariaLabel="Kembali ke beranda siswa">
            Kembali ke Beranda
          </Btn>
        </main>
      </div>
    );
  }

  const list = home.data?.exams ?? [];
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar session={session} onLogout={onLogout} />
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-deep)] p-5 text-[var(--accent-ink)] shadow-card">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage: "radial-gradient(rgb(255 255 255) 1.2px, transparent 1.2px)",
              backgroundSize: "18px 18px",
            }}
          />
          <div className="relative">
            <h2 className="text-2xl font-extrabold tracking-tight">Halo, {session.name}</h2>
            <p className="mt-1 text-sm font-medium opacity-90">
              Pilih ujian yang tersedia. Perhatikan durasi — timer berjalan begitu ujian dimulai.
              Selama ujian berlangsung, jangan membuka aplikasi lain atau keluar dari halaman:
              layar ujian otomatis terkunci dan hanya pengawas yang bisa membukanya.
            </p>
          </div>
        </div>
        <InstallAppCard compact />
        {home.isPending ? <p className="text-sm text-[var(--dim)]">Memuat ujian…</p> : null}
        {list.length === 0 && !home.isPending ? (
          <p className="rounded-2xl bg-[var(--surface)] p-5 text-sm text-[var(--dim)]">
            Belum ada ujian yang tersedia. Ujian muncul di sini setelah guru menerbitkannya.
          </p>
        ) : null}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {list.map((e) => (
            <article key={e.id} className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-lg font-extrabold text-[var(--text)]">{e.title}</h3>
                  <p className="text-sm text-[var(--dim)]">
                    {e.subject || "—"} · Guru {e.teacherName}
                  </p>
                </div>
                <Badge tone={e.myStatus === "terkunci" ? "red" : e.myStatus === "selesai" ? "green" : e.myStatus === "berlangsung" ? "amber" : "soft"}>
                  {e.myStatus === "terkunci"
                    ? "Terkunci"
                    : e.myStatus === "selesai"
                      ? "Selesai"
                      : e.myStatus === "berlangsung"
                        ? "Sedang berlangsung"
                        : "Belum dikerjakan"}
                </Badge>
              </div>
              {e.description ? <p className="mt-2 text-sm text-[var(--dim)]">{e.description}</p> : null}
              <p className="mt-2 text-sm font-semibold text-[var(--text)]">
                {e.questionCount} soal · {e.durationMinutes} menit
                {e.requireExamKey ? " · Butuh Key ujian" : ""}
              </p>
              {e.myStatus === "terkunci" ? (
                <p className="mt-3 rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                  Ujian ini terkunci karena terdeteksi keluar dari aplikasi saat ujian.
                  Minta pengawas membuka kunci akun Anda, lalu masuk lagi untuk melanjutkan.
                </p>
              ) : e.myStatus !== "selesai" ? (
                <div className="mt-3 space-y-2">
                  {e.requireExamKey && e.myStatus === "belum" ? (
                    keyReady[e.id] &&
                    keyReady[e.id] === (keyInputs[e.id] ?? "").trim().toUpperCase() ? (
                      <div className="space-y-2 rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
                        <p className="flex items-center gap-2 text-sm font-bold text-[var(--accent)]">
                          <Icon name="checkCircle" size={17} />
                          Key diterima — Anda siap memulai ujian ini.
                        </p>
                        <p className="text-sm leading-relaxed text-[var(--text)]">
                          Timer {e.durationMinutes} menit mulai berjalan begitu tombol di bawah
                          ditekan. Pastikan koneksi stabil dan jangan membuka aplikasi lain
                          selama ujian berlangsung.
                        </p>
                        {startError[e.id] ? (
                          <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                            {startError[e.id]}
                          </p>
                        ) : null}
                        <Btn
                          className="w-full"
                          disabled={start.isPending}
                          onClick={() => start.mutate({ examId: e.id, code: keyReady[e.id] ?? "" })}
                          ariaLabel={`Siap memulai ujian ${e.title}`}
                        >
                          {start.isPending ? "Memulai…" : "Siap Memulai Ujian"}
                        </Btn>
                        <Btn
                          variant="ghost"
                          disabled={start.isPending}
                          onClick={() =>
                            setKeyReady((p) => {
                              const n = { ...p };
                              delete n[e.id];
                              return n;
                            })
                          }
                          ariaLabel={`Ganti Key ujian untuk ${e.title}`}
                        >
                          Ganti Key
                        </Btn>
                      </div>
                    ) : (
                      <>
                        <input
                          {...FIELDS.startExam.examKeyCode}
                          aria-label={`Key ujian untuk ${e.title}`}
                          className={`${inputCls} uppercase tracking-widest`}
                          placeholder="UJIAN-XXXX-XXXX"
                          value={keyInputs[e.id] ?? ""}
                          onChange={(ev) => setKeyInputs((p) => ({ ...p, [e.id]: ev.target.value }))}
                          autoCapitalize="characters"
                        />
                        {keyCheckError[e.id] ? (
                          <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                            {keyCheckError[e.id]}
                          </p>
                        ) : null}
                        {startError[e.id] ? (
                          <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                            {startError[e.id]}
                          </p>
                        ) : null}
                        <Btn
                          disabled={checkKey.isPending || !(keyInputs[e.id] ?? "").trim()}
                          onClick={() =>
                            checkKey.mutate({ examId: e.id, code: (keyInputs[e.id] ?? "").trim() })
                          }
                          ariaLabel={`Pakai Key ujian untuk ${e.title}`}
                        >
                          {checkKey.isPending && checkKey.variables?.examId === e.id
                            ? "Memeriksa Key…"
                            : "Pakai Key Ujian"}
                        </Btn>
                      </>
                    )
                  ) : (
                    <>
                      {startError[e.id] ? (
                        <p role="alert" className="rounded-xl bg-[var(--danger)]/10 px-3 py-2 text-sm font-semibold text-[var(--danger)]">
                          {startError[e.id]}
                        </p>
                      ) : null}
                      <Btn
                        disabled={start.isPending}
                        onClick={() =>
                          start.mutate({ examId: e.id, code: (keyInputs[e.id] ?? "").trim() })
                        }
                        ariaLabel={e.myStatus === "berlangsung" ? `Lanjutkan ujian ${e.title}` : `Mulai ujian ${e.title}`}
                      >
                        {e.myStatus === "berlangsung" ? "Lanjutkan Ujian" : "Mulai Ujian"}
                      </Btn>
                    </>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-sm font-semibold text-[var(--accent)]">
                  Ujian sudah dikumpulkan. Nilai disampaikan oleh guru.
                </p>
              )}
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}

// ---------- Pengawas dashboard ----------

function PengawasView({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const qc = useQueryClient();
  const [actionMsg, setActionMsg] = useState("");
  const [freshLockKeys, setFreshLockKeys] = useState<Set<string>>(new Set());
  const prevLockKeysRef = useRef<Set<string> | null>(null);
  const monitor = useQuery({
    queryKey: ["pengawas-monitor", session.id],
    queryFn: () => api.pengawasMonitor({ actorId: session.id }),
    refetchInterval: 5000,
  });
  const setLock = useMutation({
    mutationFn: (v: { userId: number; locked: boolean }) =>
      api.setUserLocked({ actorId: session.id, userId: v.userId, locked: v.locked }),
    onSuccess: (_res, v) => {
      setActionMsg(v.locked ? "Akun peserta dikunci." : "Kunci dibuka — peserta bisa masuk dan melanjutkan ujian.");
      qc.invalidateQueries({ queryKey: ["pengawas-monitor"] });
    },
    onError: (e) => setActionMsg(e instanceof Error ? e.message : "Gagal mengubah status kunci."),
  });

  const groups = monitor.data?.groups ?? [];
  const allParticipants = groups.flatMap((g) => g.participants);
  const inProgress = allParticipants.filter((p) => p.status === "berlangsung").length;
  const lockedCount = new Set(
    allParticipants.filter((p) => p.status === "terkunci" || p.accountLocked).map((p) => p.studentId),
  ).size;
  const finished = allParticipants.filter((p) => p.status === "selesai").length;

  // Daftar akun terkunci — ditampilkan sebagai notifikasi di paling atas
  // layar pengawas. Satu entri per AKUN (bukan per ujian): peserta yang sama
  // bisa tercatat di banyak ujian, tetapi akunnya hanya terkunci satu kali.
  // Konteks ujian yang ditampilkan mengutamakan attempt yang terkunci.
  // Urutan: yang paling baru terkunci di atas.
  type LockedEntry = (typeof groups)[number]["participants"][number] & {
    lockKey: string;
    examTitle: string;
    subject: string;
    kelas: string;
    examCount: number;
  };
  const lockedMap = new Map<number, LockedEntry>();
  for (const g of groups) {
    for (const p of g.participants) {
      if (p.status !== "terkunci" && !p.accountLocked) continue;
      const existing = lockedMap.get(p.studentId);
      if (!existing) {
        lockedMap.set(p.studentId, {
          ...p,
          lockKey: `student:${p.studentId}`,
          examTitle: g.title,
          subject: g.subject,
          kelas: g.kelas,
          examCount: 1,
        });
        continue;
      }
      existing.examCount += 1;
      if (p.status === "terkunci" && existing.status !== "terkunci") {
        existing.status = p.status;
        existing.examTitle = g.title;
        existing.subject = g.subject;
        existing.kelas = g.kelas;
        existing.answeredCount = p.answeredCount;
      }
      if (!existing.lockReason && p.lockReason) existing.lockReason = p.lockReason;
      existing.violations = Math.max(existing.violations, p.violations);
      if (p.lockedAt && (!existing.lockedAt || p.lockedAt > existing.lockedAt)) {
        existing.lockedAt = p.lockedAt;
      }
    }
  }
  const lockedParticipants = [...lockedMap.values()].sort((a, b) => {
    const ta = a.lockedAt ? new Date(a.lockedAt).getTime() : 0;
    const tb = b.lockedAt ? new Date(b.lockedAt).getTime() : 0;
    if (tb !== ta) return tb - ta;
    if (b.violations !== a.violations) return b.violations - a.violations;
    return a.studentName.localeCompare(b.studentName);
  });
  const lockedKeysSignature = lockedParticipants.map((p) => p.lockKey).join(",");

  // Deteksi kunci BARU yang muncul di antara dua pemuatan otomatis: tandai
  // sebagai "Baru", gulir layar ke notifikasi di paling atas, dan getarkan
  // perangkat (bila didukung) supaya pengawas langsung sadar.
  useEffect(() => {
    const keys = new Set(lockedKeysSignature ? lockedKeysSignature.split(",") : []);
    const prev = prevLockKeysRef.current;
    prevLockKeysRef.current = keys;
    if (prev === null) return;
    const fresh = [...keys].filter((k) => !prev.has(k));
    if (fresh.length === 0) return;
    setFreshLockKeys(new Set(fresh));
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      navigator.vibrate?.(200);
    } catch {
      /* getar tidak didukung — abaikan */
    }
    const t = window.setTimeout(() => setFreshLockKeys(new Set()), 20000);
    return () => window.clearTimeout(t);
  }, [lockedKeysSignature]);

  const statusBadge = (p: (typeof allParticipants)[number]) => {
    if (p.status === "terkunci" || p.accountLocked) return <Badge tone="red">Terkunci</Badge>;
    if (p.status === "berlangsung") return <Badge tone="amber">Sedang ujian</Badge>;
    if (p.status === "selesai") return <Badge tone="green">Selesai</Badge>;
    return <Badge>Belum mulai</Badge>;
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar session={session} onLogout={onLogout} />
      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5">
        {lockedParticipants.length > 0 ? (
          <section
            role="alert"
            aria-live="assertive"
            aria-label={`Notifikasi: ${lockedParticipants.length} akun peserta terkunci`}
            className="sticky top-[4.5rem] z-30 overflow-hidden rounded-3xl border-2 border-[var(--danger)] bg-[var(--surface)] shadow-pop"
          >
            <div className="flex items-center gap-2.5 bg-[var(--danger)] px-4 py-3 text-white">
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/20">
                <Icon name="bell" size={19} />
                <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-white" />
                <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-white" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-extrabold leading-tight">
                  {lockedParticipants.length} Akun Terkunci
                  {freshLockKeys.size > 0 ? (
                    <span className="ml-2 inline-flex animate-pulse items-center rounded-full bg-white px-2 py-0.5 align-middle text-[11px] font-extrabold uppercase tracking-wide text-[var(--danger)]">
                      Baru saja
                    </span>
                  ) : null}
                </p>
                <p className="text-xs font-medium leading-tight opacity-90">
                  Peserta di bawah ini terkunci dan menunggu kunci akunnya dibuka.
                </p>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-lg font-extrabold text-[var(--danger)]">
                {lockedParticipants.length}
              </span>
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {lockedParticipants.map((p) => (
                <li
                  key={p.lockKey}
                  className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 ${
                    freshLockKeys.has(p.lockKey) ? "bg-[var(--danger)]/10" : "bg-[var(--danger)]/[0.04]"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 font-extrabold text-[var(--text)]">
                      <Icon name="lock" size={15} className="shrink-0 text-[var(--danger)]" />
                      {p.studentName}
                      {freshLockKeys.has(p.lockKey) ? <Badge tone="red">Baru terkunci</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--dim)]">
                      {p.examTitle}
                      {p.subject ? ` · ${p.subject}` : ""}
                      {p.kelas ? ` · Kelas ${p.kelas}` : ""}
                      {p.lockedAt ? ` · Terkunci ${fmtDate(p.lockedAt)}` : ""}
                      {p.violations > 0 ? ` · Pelanggaran ${p.violations}×` : ""}
                      {p.status !== "belum" ? ` · Terjawab ${p.answeredCount} soal` : ""}
                    </p>
                    {p.examCount > 1 ? (
                      <p className="text-xs text-[var(--dim)]">Akun ini tercatat di {p.examCount} ujian dalam pantauan.</p>
                    ) : null}
                    {p.lockReason ? (
                      <p className="text-xs font-semibold text-[var(--danger)]">Alasan: {p.lockReason}</p>
                    ) : (
                      <p className="text-xs font-semibold text-[var(--danger)]">Akun dikunci — peserta tidak bisa masuk.</p>
                    )}
                  </div>
                  <Btn
                    variant="amber"
                    disabled={setLock.isPending}
                    onClick={() => setLock.mutate({ userId: p.studentId, locked: false })}
                    ariaLabel={`Buka kunci akun ${p.studentName} dari notifikasi`}
                  >
                    <Icon name="lock" size={15} />
                    Buka Kunci
                  </Btn>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-deep)] p-5 text-[var(--accent-ink)] shadow-card">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage: "radial-gradient(rgb(255 255 255) 1.2px, transparent 1.2px)",
              backgroundSize: "18px 18px",
            }}
          />
          <div className="relative">
            <h2 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
              <Icon name="shield" size={24} />
              Pantauan Pengawas
            </h2>
            <p className="mt-1 text-sm font-medium opacity-90">
              {monitor.data?.scopeTeacherName
                ? `Memantau ujian guru ${monitor.data.scopeTeacherName} — per mata pelajaran & kelas. Halaman diperbarui otomatis.`
                : "Memantau semua ujian — per mata pelajaran & kelas. Halaman diperbarui otomatis."}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Ujian Dipantau" value={groups.length} icon="layers" />
          <StatCard label="Sedang Ujian" value={inProgress} icon="clock" tint="amber" />
          <StatCard label="Terkunci" value={lockedCount} icon="lock" tint="amber" />
          <StatCard label="Selesai" value={finished} icon="checkCircle" />
        </div>

        <InstallAppCard compact />

        {actionMsg ? (
          <p role="status" className="rounded-2xl bg-[var(--accent-soft)] px-4 py-3 text-sm font-semibold text-[var(--accent)]">
            {actionMsg}
          </p>
        ) : null}
        {monitor.isPending ? <p className="text-sm text-[var(--dim)]">Memuat pantauan…</p> : null}
        {monitor.isError ? (
          <p role="alert" className="rounded-2xl bg-[var(--danger)]/10 p-4 text-sm font-semibold text-[var(--danger)]">
            Pantauan gagal dimuat. Periksa koneksi lalu muat ulang halaman.
          </p>
        ) : null}
        {groups.length === 0 && !monitor.isPending ? (
          <p className="rounded-2xl bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
            Belum ada ujian dalam pantauan Anda. Ujian muncul di sini setelah guru yang membuat
            akun pengawas Anda membuat paket soal.
          </p>
        ) : null}

        <div className="grid items-start gap-5 xl:grid-cols-2">
        {groups.map((g) => (
          <section key={g.examId} className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-lg font-extrabold text-[var(--text)]">{g.title}</h3>
                <p className="text-sm text-[var(--dim)]">
                  {g.subject || "Tanpa mata pelajaran"}{g.kelas ? ` · Kelas ${g.kelas}` : " · Kelas belum diatur"} · Guru {g.teacherName}
                </p>
              </div>
              <Badge tone={g.isPublished ? "green" : "soft"}>{g.isPublished ? "Terbit" : "Draf"}</Badge>
            </div>
            <div className="mt-3 space-y-2">
              {g.participants.length === 0 ? (
                <p className="text-sm text-[var(--dim)]">Belum ada peserta untuk ujian ini.</p>
              ) : null}
              {g.participants.map((p) => (
                <div
                  key={p.studentId}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-3.5 py-3 ${
                    p.status === "terkunci" || p.accountLocked
                      ? "border-[var(--danger)] bg-[var(--danger)]/5"
                      : "border-[var(--border)] bg-[var(--surface2)]/60"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="font-bold text-[var(--text)]">{p.studentName}</p>
                    <p className="text-xs text-[var(--dim)]">
                      {p.status === "belum"
                        ? "Belum memulai ujian"
                        : `Mulai ${fmtDate(p.startedAt)} · Terjawab ${p.answeredCount} soal${p.submittedAt ? ` · Kumpul ${fmtDate(p.submittedAt)}` : ""}`}
                      {p.violations > 0 ? ` · Pelanggaran ${p.violations}×` : ""}
                    </p>
                    {p.lockReason && (p.status === "terkunci" || p.accountLocked) ? (
                      <p className="text-xs font-semibold text-[var(--danger)]">Alasan kunci: {p.lockReason}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(p)}
                    {p.accountLocked || p.status === "terkunci" ? (
                      <Btn
                        variant="amber"
                        disabled={setLock.isPending}
                        onClick={() => setLock.mutate({ userId: p.studentId, locked: false })}
                        ariaLabel={`Buka kunci akun ${p.studentName}`}
                      >
                        <Icon name="lock" size={15} />
                        Buka Kunci
                      </Btn>
                    ) : (
                      <Btn
                        variant="soft"
                        disabled={setLock.isPending}
                        onClick={() => setLock.mutate({ userId: p.studentId, locked: true })}
                        ariaLabel={`Kunci akun ${p.studentName}`}
                      >
                        Kunci
                      </Btn>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        </div>
      </main>
    </div>
  );
}

// ---------- App root ----------

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  const logout = () => {
    storageRemove();
    setSession(null);
  };

  if (!session) return <LoginView onLogin={setSession} />;
  if (session.role === "admin") return <AdminView session={session} onLogout={logout} />;
  if (session.role === "guru") return <TeacherView session={session} onLogout={logout} />;
  if (session.role === "pengawas") return <PengawasView session={session} onLogout={logout} />;
  return <StudentView session={session} onLogout={logout} />;
}
