import { useState, useEffect, useMemo, useRef } from "react";
import { auth, db, googleProvider } from "./src/firebase.js";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, collection, query, where, arrayUnion } from "firebase/firestore";
import QRCode from "qrcode";

const ADMIN_EMAIL = "wdgraficarapidacv@gmail.com";
const FABRICANTE_EMAIL = "nelcialves016@gmail.com";
const ESTOQUE_EMAIL = "evvuldconfeitaria@gmail.com";
const PRICE_REVENDA = 6.5;
const PRICE_CLIENTE = 12.0;
const RESELLER_THRESHOLD = 30;
const RESELLER_EXPIRY_DAYS = 30;
const RESELLER_MIN_ORDER_UNITS = 30;
const RESELLER_PAYMENT_DAYS = 7;
const PIX_CNPJ = "68.400.396/0001-06";
const PIX_MERCHANT_NAME = "Confeitaria/EVVULD";
const PIX_MERCHANT_CITY = "Jandira";
const WHATSAPP_NUMBER = "5511965873079";
const CART_NUDGE_DELAY_MS = 20 * 1000; // TEMP: 20s for testing — change back to 5 * 60 * 1000
const CART_NUDGE_MESSAGE = "Oi! Percebemos que você está há um tempinho com produtos no carrinho, mas ainda não finalizou o pedido. Está tudo bem? Precisando de ajuda, é só chamar aqui no chat que teremos o prazer de te auxiliar! 🧡";

const FLAVOR_COLORS = {
  "Maracujá": "#E8A23D",
  "Doce de Leite": "#B06B3A",
  "Ninho": "#D8C6A8",
  "Nutella": "#5B3A29",
  "Ninho com Nutella": "#8A5B3F",
  "Brigadeiro": "#3D2419",
};
// Fallback is FLAVOR_COLORS (a flat color block) for any flavor without a
// real product photo yet, e.g. a new one added later via Estoque.
const FLAVOR_IMAGES = {
  "Maracujá": "/produtos/maracuja.jpg",
  "Doce de Leite": "/produtos/doce-de-leite.jpg",
  "Ninho": "/produtos/ninho.jpg",
  "Nutella": "/produtos/nutella.jpg",
  "Ninho com Nutella": "/produtos/ninho-com-nutella.jpg",
  "Brigadeiro": "/produtos/brigadeiro.jpg",
};

const DEFAULT_PRODUCTS = Object.keys(FLAVOR_COLORS).map((flavor, i) => ({
  id: "p" + (i + 1),
  flavor,
  active: true,
}));

const DEFAULT_STOCK = [
  { id: "i1", name: "Chocolate em gotas Harald Top meio amargo", qty: 40, unit: "kg", min: 10 },
  { id: "i2", name: "Chocolate em pó Sicao 50%", qty: 25, unit: "kg", min: 8 },
  { id: "i3", name: "Farinha de trigo", qty: 60, unit: "kg", min: 15 },
  { id: "i4", name: "Manteiga Friso", qty: 30, unit: "kg", min: 10 },
  { id: "i5", name: "Açúcar cristal", qty: 50, unit: "kg", min: 15 },
  { id: "i6", name: "Ovos", qty: 300, unit: "un", min: 60 },
  { id: "i7", name: "Sal", qty: 5, unit: "kg", min: 1 },
  { id: "i8", name: "Leite condensado", qty: 40, unit: "un", min: 10 },
  { id: "i9", name: "Creme de leite", qty: 40, unit: "un", min: 10 },
  { id: "i10", name: "Leite em pó Ninho", qty: 15, unit: "kg", min: 5 },
  { id: "i11", name: "Nutella", qty: 10, unit: "kg", min: 3 },
  { id: "i12", name: "Doce de leite", qty: 15, unit: "kg", min: 5 },
  { id: "i13", name: "Polpa de maracujá", qty: 8, unit: "kg", min: 3 },
];

const STATUS_FLOW = [
  "Pedido em análise",
  "Pedido recebido",
  "Pedido em produção",
  "Pedido concluído",
  "Pedido em transporte",
  "Pedido entregue",
];
const STATUS_CANCELLED = "Pedido cancelado";

function fmtBRL(v) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function fileToCompressedDataURL(file, maxW = 480, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function daysAgo(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

// ---------- Pix BR Code (EMV QR) ----------
// Builds the standard "copia e cola" string the Central Bank defines for
// Pix QR codes, so any banking app can scan or paste it. The amount is
// optional (omit for a reusable, amount-free QR); the key itself (not
// this payload) is what actually routes the payment.
function pixTlv(id, value) {
  return id + String(value.length).padStart(2, "0") + value;
}
function pixCrc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function pixSanitize(s, maxLen) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "").slice(0, maxLen);
}
function buildPixPayload({ key, merchantName, merchantCity, amount, txid, description }) {
  const merchantInfo =
    pixTlv("00", "br.gov.bcb.pix") +
    pixTlv("01", key) +
    (description ? pixTlv("02", pixSanitize(description, 40)) : "");
  let payload =
    pixTlv("00", "01") +
    pixTlv("01", "12") +
    pixTlv("26", merchantInfo) +
    pixTlv("52", "0000") +
    pixTlv("53", "986") +
    (amount > 0 ? pixTlv("54", amount.toFixed(2)) : "") +
    pixTlv("58", "BR") +
    pixTlv("59", pixSanitize(merchantName, 25)) +
    pixTlv("60", pixSanitize(merchantCity, 15)) +
    pixTlv("62", pixTlv("05", (txid || "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***"));
  payload += "6304";
  return payload + pixCrc16(payload);
}
function buildPixCode(amount, txid) {
  return buildPixPayload({
    key: PIX_CNPJ.replace(/\D/g, ""),
    merchantName: PIX_MERCHANT_NAME,
    merchantCity: PIX_MERCHANT_CITY,
    amount,
    txid,
    description: "Doceria Metanoia",
  });
}
async function shareApp() {
  const shareData = {
    title: "Doceria Metanoia",
    text: "Conheça a Doceria Metanoia — brownies artesanais!",
    url: window.location.origin,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(shareData.url);
    alert("Link copiado! É só colar e enviar pra quem você quiser indicar.");
  } catch (e) {
    window.prompt("Copie o link para indicar:", shareData.url);
  }
}
function speakAlert(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "pt-BR";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.error("speech alert error", e);
  }
}
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "bom dia";
  if (h < 18) return "boa tarde";
  return "boa noite";
}
function announceNewOrder() {
  speakAlert(`Olá, ${timeGreeting()}. Você tem mais um pedido.`);
}
// Browsers only allow audio/speech after a real user gesture on the page,
// so the "new order" bell has to be explicitly turned on by a click —
// silently trying to speak() on page load would just fail with no sound
// and no error. The preference is per-browser (localStorage), per role.
function bellStorageKey(role) {
  return "metanoia_bell_" + role;
}
function isBellEnabled(role) {
  try {
    return localStorage.getItem(bellStorageKey(role)) === "1";
  } catch (e) {
    return false;
  }
}
function setBellEnabled(role, enabled) {
  try {
    localStorage.setItem(bellStorageKey(role), enabled ? "1" : "0");
  } catch (e) {
    console.error("bell preference save error", e);
  }
}

// Data lives in Firestore under the shared "metanoia" collection (matches
// the security rule /metanoia/{docId}). Products/resellers/stock are each
// one small document holding { items: [...] } — every viewer (client,
// fabricante, admin) reads and writes the same shared documents in real
// time. Orders get their OWN document per order (id "order_<orderId>",
// tagged kind:"order") instead of one big array: delivery-photo data URIs
// attached to each order would otherwise push a single combined document
// past Firestore's 1MB limit after a few dozen orders.
const STORAGE_KEYS = ["metanoia_products", "metanoia_resellers", "metanoia_stock"];
const METANOIA_COLLECTION = "metanoia";
const ordersQueryRef = () => query(collection(db, METANOIA_COLLECTION), where("kind", "==", "order"));
const chatsQueryRef = () => query(collection(db, METANOIA_COLLECTION), where("kind", "==", "chat"));

function docRef(key) {
  return doc(db, METANOIA_COLLECTION, key);
}
function orderDocRef(orderId) {
  return doc(db, METANOIA_COLLECTION, "order_" + orderId);
}
function stripKind(data) {
  const { kind, ...rest } = data;
  return rest;
}

async function loadAll() {
  const out = {};
  for (const k of STORAGE_KEYS) {
    try {
      const snap = await getDoc(docRef(k));
      out[k] = snap.exists() ? snap.data().items : null;
    } catch (e) {
      console.error("storage read error", k, e);
      out[k] = null;
    }
  }
  try {
    const snap = await getDocs(ordersQueryRef());
    out.metanoia_orders = snap.docs.map((d) => stripKind(d.data()));
  } catch (e) {
    console.error("orders read error", e);
    out.metanoia_orders = null;
  }
  try {
    const snap = await getDocs(chatsQueryRef());
    out.metanoia_chats = snap.docs.map((d) => stripKind(d.data()));
  } catch (e) {
    console.error("chats read error", e);
    out.metanoia_chats = null;
  }
  return out;
}
async function save(key, value) {
  try {
    await setDoc(docRef(key), { items: value });
  } catch (e) {
    console.error("storage write error", e);
  }
}
async function saveOrder(order) {
  try {
    await setDoc(orderDocRef(order.id), { kind: "order", ...order });
  } catch (e) {
    console.error("order write error", order.id, e);
  }
}
async function deleteOrderDoc(orderId) {
  try {
    await deleteDoc(orderDocRef(orderId));
  } catch (e) {
    console.error("order delete error", orderId, e);
  }
}
// One cadastro (pessoa física/jurídica) document per client, keyed by their
// own e-mail — a client must finish this before placing an order.
function clienteDocRef(email) {
  return doc(db, METANOIA_COLLECTION, "cliente_" + email);
}
async function saveCliente(email, data) {
  try {
    await setDoc(clienteDocRef(email), { kind: "cliente", email, ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("cliente save error", email, e);
  }
}
// One chat thread per client (keyed by their e-mail), visible and
// answerable at the same time from the fabricante and the adm panel.
function chatDocRef(email) {
  return doc(db, METANOIA_COLLECTION, "chat_" + email);
}
async function sendChatMessage(clientEmail, from, senderEmail, text) {
  try {
    await setDoc(
      chatDocRef(clientEmail),
      { kind: "chat", email: clientEmail, messages: arrayUnion({ from, email: senderEmail, text, at: new Date().toISOString() }), updatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {
    console.error("chat send error", clientEmail, e);
  }
}
// Subscribes to live changes on every key; onChange(key, items) fires
// whenever any viewer (this one included) writes a new value.
function subscribeAll(onChange) {
  const unsubs = STORAGE_KEYS.map((k) =>
    onSnapshot(
      docRef(k),
      (snap) => {
        if (snap.exists()) onChange(k, snap.data().items);
      },
      (e) => console.error("storage subscribe error", k, e)
    )
  );
  unsubs.push(
    onSnapshot(
      ordersQueryRef(),
      (snap) => onChange("metanoia_orders", snap.docs.map((d) => stripKind(d.data()))),
      (e) => console.error("orders subscribe error", e)
    )
  );
  unsubs.push(
    onSnapshot(
      chatsQueryRef(),
      (snap) => onChange("metanoia_chats", snap.docs.map((d) => stripKind(d.data()))),
      (e) => console.error("chats subscribe error", e)
    )
  );
  return () => unsubs.forEach((u) => u());
}

function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function printReport(title, rows) {
  const w = window.open("", "_blank");
  if (!w) return;
  const head = rows[0] || [];
  const body = rows.slice(1);
  w.document.write(`<html><head><title>${title}</title><style>
    body{font-family:sans-serif;padding:24px;color:#2C2C2A}
    h1{font-size:18px;margin-bottom:4px}
    p{color:#5F5E5A;font-size:12px;margin-top:0}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{border:1px solid #D3D1C7;padding:6px 8px;font-size:12px;text-align:left}
    th{background:#F1EFE8}
  </style></head><body>
  <h1>${title}</h1><p>Confeitaria Metanoia — gerado em ${new Date().toLocaleString("pt-BR")}</p>
  <table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c ?? ""}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></body></html>`);
  w.document.close();
  w.print();
}

function Badge({ children, tone = "gray" }) {
  const tones = {
    gray: { bg: "#F1EFE8", fg: "#444441" },
    gold: { bg: "#FAEEDA", fg: "#633806" },
    rose: { bg: "#FBEAF0", fg: "#72243E" },
    red: { bg: "#FCEBEB", fg: "#791F1F" },
    green: { bg: "#EAF3DE", fg: "#27500A" },
  };
  const t = tones[tone];
  return (
    <span style={{ background: t.bg, color: t.fg, fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function Btn({ children, onClick, variant = "primary", style = {}, disabled }) {
  const base = {
    border: "none",
    borderRadius: 8,
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "transform .1s",
  };
  const variants = {
    primary: { background: "#C4577A", color: "#fff" },
    dark: { background: "#3D2419", color: "#F5E9DA" },
    ghost: { background: "transparent", color: "#3D2419", border: "1px solid #B4B2A9" },
    danger: { background: "#E24B4A", color: "#fff" },
  };
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {children}
    </button>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E4E1D6", borderRadius: 14, padding: 18, ...style }}>
      {children}
    </div>
  );
}

const AVATAR_COLORS = ["#C4577A", "#5B3A29", "#0F6E56", "#185FA5", "#993C1D", "#3C3489"];
function avatarColor(email) {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = email.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function initials(email) {
  const name = email.split("@")[0];
  return name.slice(0, 2).toUpperCase();
}
// photoURL viria de user.photoURL após um login real com o Google (Google Identity Services).
function Avatar({ email, photoURL, size = 36 }) {
  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={email}
        referrerPolicy="no-referrer"
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      title={email}
      style={{
        width: size, height: size, borderRadius: "50%", background: avatarColor(email),
        color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: size * 0.4, fontWeight: 700, flexShrink: 0,
      }}
    >
      {initials(email)}
    </div>
  );
}

function CartIcon({ count, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Carrinho de compras"
      style={{
        position: "relative", border: "1px solid #E4E1D6", background: "#fff", borderRadius: 10,
        width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3D2419" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
      {count > 0 && (
        <span style={{
          position: "absolute", top: -6, right: -6, background: "#C4577A", color: "#fff",
          fontSize: 11, fontWeight: 700, borderRadius: 999, minWidth: 18, height: 18,
          display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px",
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

function StatusBadge({ status }) {
  if (status === STATUS_CANCELLED) return <Badge tone="red">{status}</Badge>;
  if (status === "Pedido entregue") return <Badge tone="green">{status}</Badge>;
  return <Badge tone="gold">{status}</Badge>;
}

function Header({ email, role, photoURL, onLogout }) {
  const roleLabel = {
    cliente: "Painel do cliente",
    revenda: "Painel de revenda",
    fabricante: "Painel do fabricante",
    estoque: "Controle de estoque",
    adm: "Painel administrativo",
  }[role];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
      <div>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 22, color: "#3D2419", fontWeight: 700 }}>Metanoia</div>
        <div style={{ fontSize: 13, color: "#8A7A63" }}>{roleLabel}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar email={email} photoURL={photoURL} size={32} />
        <span style={{ fontSize: 13, color: "#5F5E5A" }}>{email}</span>
        <Btn variant="ghost" onClick={shareApp} style={{ padding: "6px 14px", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3D2419" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          Indicar
        </Btn>
        <Btn variant="ghost" onClick={onLogout} style={{ padding: "6px 14px", fontSize: 13 }}>Sair</Btn>
      </div>
    </div>
  );
}

// ---------- Login ----------
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.5 29.3 35.5 24 35.5c-6.4 0-11.6-5.2-11.6-11.6S17.6 12.3 24 12.3c3 0 5.6 1.1 7.7 2.9l5.7-5.7C33.9 6.5 29.2 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.8 19 12.3 24 12.3c3 0 5.6 1.1 7.7 2.9l5.7-5.7C33.9 6.5 29.2 4.5 24 4.5c-7.5 0-14 4.2-17.7 10.2z"/>
      <path fill="#4CAF50" d="M24 43.5c5.1 0 9.7-1.9 13.2-5.1l-6.1-5.2c-2 1.5-4.5 2.3-7.1 2.3-5.3 0-9.7-3.5-11.3-8.3l-6.5 5C9.9 39.1 16.4 43.5 24 43.5z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.3 5.5l6.1 5.2C40.6 35.9 43.5 30.4 43.5 24c0-1.2-.1-2.4-.4-3.5z"/>
    </svg>
  );
}
function Login({ onLogin, loggingIn, loginError }) {
  return (
    <div style={{ minHeight: 480, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Card style={{ width: 340, textAlign: "center" }}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 30, color: "#3D2419", fontWeight: 700, marginBottom: 2 }}>Metanoia</div>
        <div style={{ fontSize: 13, color: "#8A7A63", marginBottom: 22 }}>Adoçando a vida — brownies artesanais</div>
        {loginError && <div style={{ color: "#C4394A", fontSize: 12, marginBottom: 12 }}>{loginError}</div>}
        <Btn
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}
          disabled={loggingIn}
          onClick={onLogin}
        >
          <GoogleIcon />
          {loggingIn ? "Entrando…" : "Entrar com o Google"}
        </Btn>
        <div style={{ fontSize: 11, color: "#B4B2A9", marginTop: 14 }}>
          Login com sua conta Google de verdade. As contas de fabricante, estoque e adm abrem seus painéis automaticamente ao entrar.
        </div>
      </Card>
    </div>
  );
}

// ---------- Storefront (cliente / revenda) ----------
function DeliveryConfirm({ order, onConfirmDelivery }) {
  const [uploading, setUploading] = useState(false);
  const finalStatuses = ["Pedido entregue", STATUS_CANCELLED];
  if (finalStatuses.includes(order.status)) {
    if (order.deliveryPhoto) {
      return (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <img src={order.deliveryPhoto} alt="Foto da entrega" style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} />
          <span style={{ fontSize: 12, color: "#8A7A63" }}>Entrega confirmada com foto</span>
        </div>
      );
    }
    return null;
  }
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid #E4E1D6", paddingTop: 10 }}>
      <label style={{ display: "inline-block" }}>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          disabled={uploading}
          onChange={async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            setUploading(true);
            try {
              const dataUrl = await fileToCompressedDataURL(file);
              await onConfirmDelivery(order.id, dataUrl);
            } finally {
              setUploading(false);
            }
          }}
        />
        <span>
          <Btn variant="ghost" disabled={uploading} style={{ padding: "6px 14px", fontSize: 12 }}>
            {uploading ? "Enviando foto…" : "📷 Confirmar entrega com foto"}
          </Btn>
        </span>
      </label>
      <div style={{ fontSize: 11, color: "#B4B2A9", marginTop: 4 }}>
        Ao tirar a foto do produto recebido, o status muda automaticamente para "Pedido entregue".
      </div>
    </div>
  );
}

function CadastroForm({ onSave }) {
  const [tipo, setTipo] = useState("fisica");
  const [nome, setNome] = useState("");
  const [documento, setDocumento] = useState("");
  const [endereco, setEndereco] = useState("");
  const [telefone, setTelefone] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const docLabel = tipo === "fisica" ? "CPF" : "CNPJ";
  const docLen = tipo === "fisica" ? 11 : 14;
  const inputStyle = { padding: 8, borderRadius: 8, border: "1px solid #D3D1C7", boxSizing: "border-box", width: "100%" };

  async function handleSave() {
    const docDigits = documento.replace(/\D/g, "");
    if (!nome.trim() || !endereco.trim() || !telefone.trim()) { setErr("Preencha todos os campos."); return; }
    if (docDigits.length !== docLen) { setErr(`${docLabel} inválido — deve ter ${docLen} dígitos.`); return; }
    setErr("");
    setSaving(true);
    try {
      await onSave({ tipo, nome: nome.trim(), documento: docDigits, endereco: endereco.trim(), telefone: telefone.trim() });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ marginBottom: 18, background: "#FBEAF0" }}>
      <div style={{ fontWeight: 700, color: "#72243E", marginBottom: 4 }}>Complete seu cadastro</div>
      <div style={{ fontSize: 13, color: "#72243E", marginBottom: 14 }}>
        Para finalizar pedidos, precisamos dos seus dados de pessoa física ou jurídica.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Btn variant={tipo === "fisica" ? "dark" : "ghost"} style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => { setTipo("fisica"); setDocumento(""); setErr(""); }}>Pessoa física</Btn>
        <Btn variant={tipo === "juridica" ? "dark" : "ghost"} style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => { setTipo("juridica"); setDocumento(""); setErr(""); }}>Pessoa jurídica</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input placeholder={tipo === "fisica" ? "Nome completo" : "Razão social"} value={nome} onChange={(e) => setNome(e.target.value)} style={inputStyle} />
        <input placeholder={docLabel} value={documento} onChange={(e) => setDocumento(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input placeholder="Endereço" value={endereco} onChange={(e) => setEndereco(e.target.value)} style={inputStyle} />
        <input placeholder="Telefone/WhatsApp" value={telefone} onChange={(e) => setTelefone(e.target.value)} style={inputStyle} />
      </div>
      {err && <div style={{ color: "#C4394A", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <Btn style={{ width: "100%" }} disabled={saving} onClick={handleSave}>{saving ? "Salvando…" : "Salvar cadastro"}</Btn>
    </Card>
  );
}

function SalesReportForm({ order, onSubmit }) {
  const [vendidos, setVendidos] = useState(() => Object.fromEntries(order.items.map((it) => [it.productId, 0])));
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    for (const it of order.items) {
      const v = Number(vendidos[it.productId]);
      if (!Number.isFinite(v) || v < 0 || v > it.qty) { setErr(`Quantidade vendida de ${it.flavor} deve ser entre 0 e ${it.qty}.`); return; }
    }
    setErr("");
    setSaving(true);
    try {
      await onSubmit(order.id, order.items.map((it) => {
        const v = Number(vendidos[it.productId]) || 0;
        return { productId: it.productId, flavor: it.flavor, vendidos: v, restantes: it.qty - v };
      }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid #E4E1D6", paddingTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3D2419", marginBottom: 6 }}>Informe as vendas desse pedido</div>
      {order.items.map((it) => (
        <div key={it.productId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 4 }}>
          <span>{it.flavor} ({it.qty} un.)</span>
          <input
            type="number" min={0} max={it.qty}
            value={vendidos[it.productId]}
            onChange={(e) => setVendidos((v) => ({ ...v, [it.productId]: e.target.value }))}
            style={{ width: 64, padding: 6, borderRadius: 6, border: "1px solid #D3D1C7" }}
          />
        </div>
      ))}
      {err && <div style={{ color: "#C4394A", fontSize: 12, marginTop: 4 }}>{err}</div>}
      <Btn style={{ marginTop: 8, width: "100%" }} disabled={saving} onClick={handleSubmit}>{saving ? "Enviando…" : "Enviar relatório de vendas"}</Btn>
    </div>
  );
}

// ---------- Chat ----------
function ChatThread({ messages, onSend, placeholder }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await onSend(text.trim());
      setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto", marginBottom: 10, padding: 2 }}>
        {(!messages || messages.length === 0) && <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhuma mensagem ainda.</div>}
        {(messages || []).map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.from === "cliente" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "80%", background: m.from === "cliente" ? "#C4577A" : "#F1EFE8",
              color: m.from === "cliente" ? "#fff" : "#3D2419",
              borderRadius: 12, padding: "8px 12px", fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {m.text}
            </div>
            <div style={{ fontSize: 10, color: "#B4B2A9", marginTop: 2 }}>
              {m.from !== "cliente" ? `${m.from}${m.email ? " · " + m.email : ""} · ` : ""}{new Date(m.at).toLocaleString("pt-BR")}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
          placeholder={placeholder || "Digite sua mensagem…"}
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }}
        />
        <Btn disabled={sending} onClick={handleSend}>Enviar</Btn>
      </div>
    </div>
  );
}

function ChatPanel({ chats, orders, onSend }) {
  const [selected, setSelected] = useState(null);
  const sorted = [...chats].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  const active = sorted.find((c) => c.email === selected) || sorted[0] || null;

  function clientWhatsapp(clientEmail) {
    const last = [...orders].filter((o) => o.email === clientEmail).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    return last && last.whatsapp ? last.whatsapp.replace(/\D/g, "") : null;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sorted.length === 0 && <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhuma conversa ainda.</div>}
        {sorted.map((c) => {
          const last = c.messages && c.messages[c.messages.length - 1];
          const isActive = active && active.email === c.email;
          return (
            <button
              key={c.email}
              onClick={() => setSelected(c.email)}
              style={{
                textAlign: "left", padding: 8, borderRadius: 8, cursor: "pointer",
                border: "1px solid " + (isActive ? "#C4577A" : "#E4E1D6"),
                background: isActive ? "#FBEAF0" : "#fff",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13, color: "#3D2419" }}>{c.email}</div>
              <div style={{ fontSize: 11, color: "#8A7A63", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{last ? last.text : ""}</div>
            </button>
          );
        })}
      </div>
      <Card>
        {active ? (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontWeight: 700, color: "#3D2419" }}>{active.email}</div>
              {clientWhatsapp(active.email) && (
                <a href={`https://wa.me/55${clientWhatsapp(active.email)}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#27500A", fontWeight: 600 }}>
                  Abrir WhatsApp do cliente
                </a>
              )}
            </div>
            <ChatThread messages={active.messages} onSend={(text) => onSend(active.email, text)} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#8A7A63" }}>Selecione uma conversa.</div>
        )}
      </Card>
    </div>
  );
}

function Storefront({ email, role, products, orders, resellerInfo, cadastro, onSaveCadastro, onPlaceOrder, onRequestReseller, onConfirmDelivery, onSubmitSalesReport, chats, onSendChatMessage }) {
  const myChat = chats.find((c) => c.email === email);
  const [cart, setCart] = useState({});
  const [addr, setAddr] = useState("");
  const [whats, setWhats] = useState("");
  const [paymentProof, setPaymentProof] = useState(null);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [tab, setTab] = useState("loja");
  const [showCartModal, setShowCartModal] = useState(false);
  const [pixQrImage, setPixQrImage] = useState(null);
  const [orderType, setOrderType] = useState("novo"); // "novo" | "reposicao" (revenda only)

  const price = role === "revenda" ? PRICE_REVENDA : PRICE_CLIENTE;
  const activeProducts = products.filter((p) => p.active);
  const cartItems = Object.entries(cart).filter(([, q]) => q > 0);
  const total = cartItems.reduce((s, [, q]) => s + q * price, 0);
  const totalUnits = cartItems.reduce((s, [, q]) => s + q, 0);

  useEffect(() => {
    if (role !== "cliente" || total <= 0) { setPixQrImage(null); return; }
    let cancelled = false;
    QRCode.toDataURL(buildPixCode(total), { width: 220, margin: 1 })
      .then((url) => { if (!cancelled) setPixQrImage(url); })
      .catch((e) => { console.error("pix qr error", e); if (!cancelled) setPixQrImage(null); });
    return () => { cancelled = true; };
  }, [role, total]);

  // Abandoned-cart nudge: if items sit in the cart for a while with no
  // checkout, send one automated chat message offering help, plus a modal
  // + spoken alert to actually get the client's attention. Resets once
  // the cart empties (checkout or cleared), so a later cart can nudge again.
  const [cartNudged, setCartNudged] = useState(false);
  const [showNudgeModal, setShowNudgeModal] = useState(false);
  useEffect(() => {
    if (cartItems.length === 0) { setCartNudged(false); return; }
    if (cartNudged) return;
    const timer = setTimeout(() => {
      onSendChatMessage(email, "sistema", null, CART_NUDGE_MESSAGE);
      setShowNudgeModal(true);
      speakAlert("Ei! Precisa de ajuda com o seu pedido?");
      setCartNudged(true);
    }, CART_NUDGE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [cartItems.length, cartNudged, email, onSendChatMessage]);

  const myOrders = orders.filter((o) => o.email === email).sort((a, b) => new Date(b.date) - new Date(a.date));
  const pendingConsignment = myOrders.find((o) => o.role === "revenda" && o.paymentType === "consignado" && o.paymentStatus !== "pago");

  // Reseller minimums: a "novo pedido" always needs RESELLER_MIN_ORDER_UNITS
  // (so the very first purchase does too). A "reposição" may be as small as
  // what was sold in the previous order's sales report — but only possible
  // once that report exists — and can always be larger if they want.
  const lastRevendaOrder = myOrders.find((o) => o.role === "revenda");
  const lastSales = lastRevendaOrder && lastRevendaOrder.salesReport ? lastRevendaOrder.salesReport.items : [];
  const soldUnits = lastSales.reduce((s, it) => s + it.vendidos, 0);
  const canRestock = soldUnits > 0;
  const effectiveOrderType = role === "revenda" && canRestock ? orderType : "novo";
  const minUnits = effectiveOrderType === "reposicao" ? soldUnits : RESELLER_MIN_ORDER_UNITS;

  const canRequestReseller = role === "cliente" && (!resellerInfo || resellerInfo.status === "inativo");
  const pendingRequest = resellerInfo && resellerInfo.status === "pendente";

  function addQty(id, delta) {
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] || 0) + delta) }));
  }

  async function handleProofUpload(file) {
    if (!file) return;
    setUploadingProof(true);
    try {
      setPaymentProof(await fileToCompressedDataURL(file));
    } finally {
      setUploadingProof(false);
    }
  }

  function copyPixKey() {
    const code = total > 0 ? buildPixCode(total) : PIX_CNPJ;
    navigator.clipboard?.writeText(code).then(
      () => alert(total > 0 ? "Código Pix copiado! Cole no app do seu banco (\"Pix Copia e Cola\")." : "Chave Pix copiada!"),
      () => {}
    );
  }

  function checkout() {
    if (cartItems.length === 0) return;
    if (!cadastro) { alert("Finalize seu cadastro (pessoa física ou jurídica) antes de fazer o pedido."); return; }
    if (!addr.trim() || !whats.trim()) { alert("Preencha endereço e WhatsApp para finalizar o pedido."); return; }

    const baseOrder = {
      id: uid(),
      email,
      role,
      items: cartItems.map(([productId, qty]) => {
        const p = products.find((pr) => pr.id === productId);
        return { productId, flavor: p.flavor, qty, unitPrice: price };
      }),
      total,
      address: addr,
      whatsapp: whats,
      status: STATUS_FLOW[0],
      date: new Date().toISOString(),
    };

    if (role === "revenda") {
      if (pendingConsignment) { alert("Você ainda tem uma consignação em aberto. Informe as vendas e aguarde a confirmação do pagamento antes de fazer um novo pedido."); return; }
      if (totalUnits < minUnits) {
        alert(effectiveOrderType === "reposicao"
          ? `Para repor o que foi vendido, o pedido precisa ter no mínimo ${soldUnits} unidades (você selecionou ${totalUnits}).`
          : `Um novo pedido de revenda precisa ter no mínimo ${RESELLER_MIN_ORDER_UNITS} unidades (você selecionou ${totalUnits}).`);
        return;
      }
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + RESELLER_PAYMENT_DAYS);
      onPlaceOrder({ ...baseOrder, orderType: effectiveOrderType, paymentType: "consignado", paymentStatus: "pendente", paymentDueDate: dueDate.toISOString() });
      setCart({}); setAddr(""); setWhats(""); setOrderType("novo");
      return;
    }

    if (!paymentProof) { alert("Envie o comprovante do pagamento via Pix para finalizar o pedido."); return; }
    onPlaceOrder({ ...baseOrder, paymentMethod: "Pix", paymentProof });
    setCart({}); setAddr(""); setWhats(""); setPaymentProof(null);
  }

  function cancelCart() {
    if (cartItems.length === 0) return false;
    if (!confirm("Cancelar esse pedido? Os itens do carrinho serão removidos.")) return false;
    setCart({});
    setAddr("");
    setWhats("");
    setPaymentProof(null);
    return true;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, gap: 10 }}>
        <CartIcon count={cartItems.reduce((s, [, q]) => s + q, 0)} onClick={() => setShowCartModal(true)} />
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant={tab === "loja" ? "dark" : "ghost"} onClick={() => setTab("loja")}>Painel</Btn>
          <Btn variant={tab === "pedidos" ? "dark" : "ghost"} onClick={() => setTab("pedidos")}>Meus pedidos ({myOrders.length})</Btn>
          <Btn variant={tab === "chat" ? "dark" : "ghost"} onClick={() => setTab("chat")}>Chat</Btn>
        </div>
      </div>

      {!cadastro && <CadastroForm onSave={onSaveCadastro} />}

      {role === "cliente" && (
        <Card style={{ marginBottom: 18, background: "#FBEAF0" }}>
          {pendingRequest ? (
            <div style={{ fontSize: 13, color: "#72243E" }}>
              Sua solicitação de revenda está aguardando aprovação do adm.
            </div>
          ) : resellerInfo && resellerInfo.status === "ativo" ? (
            <div style={{ fontSize: 13, color: "#72243E" }}>
              Você já é revendedor(a) ativo(a) — troque de painel usando o seletor de acesso.
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontSize: 13, color: "#72243E" }}>
                Descubra os benefícios de se tornar um revendedor.
              </div>
              {canRequestReseller && <Btn onClick={() => onRequestReseller(email)}>Torne-se um revendedor</Btn>}
            </div>
          )}
        </Card>
      )}

      {tab === "loja" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
            {activeProducts.map((p) => (
              <Card key={p.id}>
                {FLAVOR_IMAGES[p.flavor] ? (
                  <img
                    src={FLAVOR_IMAGES[p.flavor]}
                    alt={`Brownie ${p.flavor}`}
                    style={{ width: "100%", height: 90, borderRadius: 10, marginBottom: 10, objectFit: "cover" }}
                  />
                ) : (
                  <div style={{ width: "100%", height: 90, borderRadius: 10, background: FLAVOR_COLORS[p.flavor], marginBottom: 10 }} />
                )}
                <div style={{ fontWeight: 700, color: "#3D2419", marginBottom: 2 }}>Brownie {p.flavor}</div>
                <div style={{ fontSize: 13, color: "#8A7A63", marginBottom: 10 }}>70g</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, color: "#C4577A" }}>{fmtBRL(price)}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Btn variant="ghost" style={{ padding: "2px 10px" }} onClick={() => addQty(p.id, -1)}>-</Btn>
                    <span style={{ minWidth: 16, textAlign: "center" }}>{cart[p.id] || 0}</span>
                    <Btn variant="ghost" style={{ padding: "2px 10px" }} onClick={() => addQty(p.id, 1)}>+</Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <Card style={{ marginTop: 18 }}>
            <div style={{ fontWeight: 700, marginBottom: 10, color: "#3D2419" }}>Carrinho</div>
            {cartItems.length === 0 ? (
              <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhum item selecionado ainda.</div>
            ) : (
              <div>
                {cartItems.map(([id, q]) => {
                  const p = products.find((pr) => pr.id === id);
                  return (
                    <div key={id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                      <span>{q}x Brownie {p.flavor}</span>
                      <span>{fmtBRL(q * price)}</span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, marginTop: 8, borderTop: "1px solid #E4E1D6", paddingTop: 8 }}>
                  <span>Total</span>
                  <span>{fmtBRL(total)}</span>
                </div>
                {role === "revenda" && pendingConsignment ? (
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#FBEAF0", color: "#72243E", fontSize: 13 }}>
                    Você tem uma consignação em aberto (vence em {new Date(pendingConsignment.paymentDueDate).toLocaleDateString("pt-BR")}).
                    Informe as vendas e aguarde a confirmação do pagamento em "Meus pedidos" antes de fazer um novo pedido.
                  </div>
                ) : (
                  <>
                    {role === "revenda" && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#3D2419", marginBottom: 6 }}>Tipo do pedido</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                          <Btn variant={effectiveOrderType === "novo" ? "dark" : "ghost"} style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => setOrderType("novo")}>
                            Novo pedido (mín. {RESELLER_MIN_ORDER_UNITS} un.)
                          </Btn>
                          <Btn
                            variant={effectiveOrderType === "reposicao" ? "dark" : "ghost"}
                            style={{ padding: "6px 14px", fontSize: 13 }}
                            disabled={!canRestock}
                            onClick={() => setOrderType("reposicao")}
                          >
                            Reposição{canRestock ? ` (mín. ${soldUnits} un.)` : ""}
                          </Btn>
                        </div>
                        <div style={{ fontSize: 12, color: "#8A7A63" }}>
                          {canRestock
                            ? <>Você informou {soldUnits} unidades vendidas no último pedido ({lastSales.filter((it) => it.vendidos > 0).map((it) => `${it.flavor}: ${it.vendidos}`).join(", ")}). Na reposição você pode pedir só o que vendeu ou mais.</>
                            : lastRevendaOrder
                              ? <>Para fazer uma reposição, informe as vendas do pedido anterior em "Meus pedidos".</>
                              : <>Na primeira compra o mínimo é de {RESELLER_MIN_ORDER_UNITS} unidades.</>}
                          {" "}({totalUnits} selecionadas) · Pagamento consignado, com {RESELLER_PAYMENT_DAYS} dias de prazo após a entrega.
                        </div>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
                      <input placeholder="Endereço de entrega" value={addr} onChange={(e) => setAddr(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
                      <input placeholder="WhatsApp" value={whats} onChange={(e) => setWhats(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
                    </div>
                    {role === "cliente" && (
                      <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: "1px solid #D3D1C7" }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: "#3D2419", marginBottom: 4 }}>Pagamento via Pix</div>
                        <div style={{ fontSize: 12, color: "#8A7A63", marginBottom: 6 }}>Chave Pix (CNPJ): <strong>{PIX_CNPJ}</strong></div>
                        {pixQrImage && (
                          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
                            <img src={pixQrImage} alt="QR Code Pix" style={{ width: 160, height: 160, borderRadius: 8, border: "1px solid #E4E1D6" }} />
                          </div>
                        )}
                        <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={copyPixKey}>
                          {total > 0 ? "Copiar código Pix (copia e cola)" : "Copiar chave Pix"}
                        </Btn>
                        <div style={{ marginTop: 10 }}>
                          <label>
                            <input
                              type="file" accept="image/*" style={{ display: "none" }} disabled={uploadingProof}
                              onChange={(e) => handleProofUpload(e.target.files && e.target.files[0])}
                            />
                            <span>
                              <Btn variant="ghost" disabled={uploadingProof} style={{ padding: "6px 14px", fontSize: 12 }}>
                                {uploadingProof ? "Enviando…" : paymentProof ? "Trocar comprovante" : "📎 Enviar comprovante de pagamento"}
                              </Btn>
                            </span>
                          </label>
                          {paymentProof && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                              <img src={paymentProof} alt="Comprovante" style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover" }} />
                              <span style={{ fontSize: 12, color: "#8A7A63" }}>Comprovante anexado</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <Btn variant="ghost" style={{ flex: 1 }} onClick={cancelCart}>Cancelar pedido</Btn>
                      <Btn style={{ flex: 2 }} disabled={!cadastro} onClick={checkout}>
                        {cadastro ? "Finalizar pedido" : "Complete seu cadastro acima"}
                      </Btn>
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "pedidos" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {myOrders.length === 0 && <div style={{ fontSize: 13, color: "#8A7A63" }}>Você ainda não fez pedidos.</div>}
          {myOrders.map((o) => (
            <Card key={o.id}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#8A7A63" }}>
                  {new Date(o.date).toLocaleString("pt-BR")}{" "}
                  {o.orderType && <Badge tone={o.orderType === "reposicao" ? "rose" : "gray"}>{o.orderType === "reposicao" ? "reposição" : "novo pedido"}</Badge>}
                </span>
                <StatusBadge status={o.status} />
              </div>
              <div style={{ fontSize: 13 }}>
                {o.items.map((it, i) => <div key={i}>{it.qty}x Brownie {it.flavor}</div>)}
              </div>
              <div style={{ fontWeight: 700, marginTop: 6 }}>{fmtBRL(o.total)}</div>
              {o.paymentMethod === "Pix" && o.paymentProof && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <img src={o.paymentProof} alt="Comprovante Pix" style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} />
                  <span style={{ fontSize: 12, color: "#8A7A63" }}>Comprovante Pix enviado</span>
                </div>
              )}
              {o.paymentType === "consignado" && (
                <div style={{ marginTop: 6, fontSize: 12, color: "#8A7A63" }}>
                  Consignado · vence em {new Date(o.paymentDueDate).toLocaleDateString("pt-BR")} ·{" "}
                  <Badge tone={o.paymentStatus === "pago" ? "green" : "gold"}>{o.paymentStatus === "pago" ? "pago" : "pagamento pendente"}</Badge>
                </div>
              )}
              {o.paymentType === "consignado" && !o.salesReport && (
                <SalesReportForm order={o} onSubmit={onSubmitSalesReport} />
              )}
              {o.salesReport && (
                <div style={{ marginTop: 10, borderTop: "1px solid #E4E1D6", paddingTop: 10, fontSize: 12, color: "#8A7A63" }}>
                  <div style={{ fontWeight: 700, color: "#3D2419", marginBottom: 4 }}>Vendas informadas</div>
                  {o.salesReport.items.map((it) => <div key={it.productId}>{it.flavor}: {it.vendidos} vendidos, {it.restantes} restantes</div>)}
                </div>
              )}
              <DeliveryConfirm order={o} onConfirmDelivery={onConfirmDelivery} />
            </Card>
          ))}
        </div>
      )}

      {tab === "chat" && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 4, color: "#3D2419" }}>Fale com a gente</div>
          <div style={{ fontSize: 12, color: "#8A7A63", marginBottom: 10 }}>
            Tire suas dúvidas por aqui ou direto pelo WhatsApp:{" "}
            <a href={`https://wa.me/${WHATSAPP_NUMBER}`} target="_blank" rel="noreferrer" style={{ color: "#C4577A", fontWeight: 600 }}>(11) 96587-3079</a>
          </div>
          <ChatThread messages={myChat && myChat.messages} onSend={(text) => onSendChatMessage(email, "cliente", email, text)} />
        </Card>
      )}

      {showCartModal && (
        <div
          onClick={() => setShowCartModal(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(61,36,25,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 380 }}>
            <Card>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#3D2419", marginBottom: 10 }}>Seu carrinho</div>
              {cartItems.length === 0 ? (
                <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhum item selecionado ainda.</div>
              ) : (
                <div>
                  {cartItems.map(([id, q]) => {
                    const p = products.find((pr) => pr.id === id);
                    return (
                      <div key={id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                        <span>{q}x Brownie {p.flavor}</span>
                        <span>{fmtBRL(q * price)}</span>
                      </div>
                    );
                  })}
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, marginTop: 8, borderTop: "1px solid #E4E1D6", paddingTop: 8 }}>
                    <span>Total</span>
                    <span>{fmtBRL(total)}</span>
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setShowCartModal(false)}>Fechar</Btn>
                {cartItems.length > 0 && (
                  <>
                    <Btn variant="danger" style={{ flex: 1 }} onClick={() => { if (cancelCart()) setShowCartModal(false); }}>Cancelar</Btn>
                    <Btn style={{ flex: 1 }} onClick={() => { setShowCartModal(false); setTab("loja"); }}>Finalizar</Btn>
                  </>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {showNudgeModal && (
        <div
          onClick={() => setShowNudgeModal(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(61,36,25,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 360 }}>
            <Card>
              <div style={{ fontSize: 32, textAlign: "center", marginBottom: 8 }}>🔔</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#3D2419", marginBottom: 8, textAlign: "center" }}>Precisa de uma mãozinha?</div>
              <div style={{ fontSize: 13, color: "#5F5E5A", marginBottom: 14, textAlign: "center" }}>{CART_NUDGE_MESSAGE}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setShowNudgeModal(false)}>Fechar</Btn>
                <Btn style={{ flex: 1 }} onClick={() => { setShowNudgeModal(false); setTab("chat"); }}>Ir para o chat</Btn>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// Lets fabricante/adm hand-register a client that pre-dates this system
// (e.g. someone who only ever ordered by WhatsApp), so their cadastro
// exists and old/offline orders can be logged against it.
function ManualClienteForm() {
  const inputStyle = { padding: 8, borderRadius: 8, border: "1px solid #D3D1C7", boxSizing: "border-box", width: "100%" };
  const [email, setEmail] = useState("");
  const [tipo, setTipo] = useState("fisica");
  const [nome, setNome] = useState("");
  const [documento, setDocumento] = useState("");
  const [endereco, setEndereco] = useState("");
  const [telefone, setTelefone] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const docLabel = tipo === "fisica" ? "CPF" : "CNPJ";
  const docLen = tipo === "fisica" ? 11 : 14;

  async function handleSave() {
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setErr("Digite um e-mail válido."); setMsg(""); return; }
    const docDigits = documento.replace(/\D/g, "");
    if (!nome.trim() || !endereco.trim() || !telefone.trim()) { setErr("Preencha todos os campos."); setMsg(""); return; }
    if (docDigits.length !== docLen) { setErr(`${docLabel} inválido — deve ter ${docLen} dígitos.`); setMsg(""); return; }
    setErr(""); setMsg(""); setSaving(true);
    try {
      await saveCliente(em, { tipo, nome: nome.trim(), documento: docDigits, endereco: endereco.trim(), telefone: telefone.trim() });
      setMsg(`Cliente ${em} cadastrado!`);
      setEmail(""); setNome(""); setDocumento(""); setEndereco(""); setTelefone("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 10, color: "#3D2419" }}>Criar cliente</div>
      <input placeholder="E-mail do cliente" value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Btn variant={tipo === "fisica" ? "dark" : "ghost"} style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => { setTipo("fisica"); setDocumento(""); }}>Pessoa física</Btn>
        <Btn variant={tipo === "juridica" ? "dark" : "ghost"} style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => { setTipo("juridica"); setDocumento(""); }}>Pessoa jurídica</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input placeholder={tipo === "fisica" ? "Nome completo" : "Razão social"} value={nome} onChange={(e) => setNome(e.target.value)} style={inputStyle} />
        <input placeholder={docLabel} value={documento} onChange={(e) => setDocumento(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input placeholder="Endereço" value={endereco} onChange={(e) => setEndereco(e.target.value)} style={inputStyle} />
        <input placeholder="Telefone/WhatsApp" value={telefone} onChange={(e) => setTelefone(e.target.value)} style={inputStyle} />
      </div>
      {err && <div style={{ color: "#C4394A", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {msg && <div style={{ color: "#27500A", fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <Btn disabled={saving} onClick={handleSave}>{saving ? "Salvando…" : "Salvar cliente"}</Btn>
    </Card>
  );
}

// Logs an order that already happened outside the system (old WhatsApp/
// in-person sale) against any client e-mail, with an editable date/status
// instead of the live checkout flow's Pix/consignment requirements.
function ManualOrderForm({ products }) {
  const inputStyle = { padding: 8, borderRadius: 8, border: "1px solid #D3D1C7", boxSizing: "border-box", width: "100%" };
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("cliente");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [status, setStatus] = useState("Pedido entregue");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [address, setAddress] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [qtyByProduct, setQtyByProduct] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const price = role === "revenda" ? PRICE_REVENDA : PRICE_CLIENTE;
  const items = products.filter((p) => Number(qtyByProduct[p.id]) > 0).map((p) => ({
    productId: p.id, flavor: p.flavor, qty: Number(qtyByProduct[p.id]), unitPrice: price,
  }));
  const total = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);

  async function handleSave() {
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setErr("Digite um e-mail válido."); setMsg(""); return; }
    if (items.length === 0) { setErr("Selecione ao menos um item (quantidade maior que zero)."); setMsg(""); return; }
    setErr(""); setMsg(""); setSaving(true);
    try {
      const order = {
        id: uid(),
        email: em,
        role,
        items,
        total,
        address: address.trim() || "Pedido lançado manualmente",
        whatsapp: whatsapp.trim() || "-",
        status,
        date: new Date(date).toISOString(),
        manualEntry: true,
      };
      if (paymentMethod) order.paymentMethod = paymentMethod;
      await saveOrder(order);
      setMsg(`Pedido de ${em} lançado!`);
      setQtyByProduct({});
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 10, color: "#3D2419" }}>Lançar pedido antigo</div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 8 }}>
        <input placeholder="E-mail do cliente" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
          <option value="cliente">Cliente final</option>
          <option value="revenda">Revenda</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
          {[...STATUS_FLOW, STATUS_CANCELLED].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
        <input placeholder="Endereço (opcional)" value={address} onChange={(e) => setAddress(e.target.value)} style={inputStyle} />
        <input placeholder="WhatsApp (opcional)" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} style={inputStyle} />
        <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} style={inputStyle}>
          <option value="">Forma de pagamento</option>
          {PAYMENT_METHODS.map((pm) => <option key={pm} value={pm}>{pm}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 12, color: "#8A7A63", marginBottom: 6 }}>Itens ({role === "revenda" ? "preço revenda" : "preço cliente"}):</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginBottom: 10 }}>
        {products.map((p) => (
          <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, border: "1px solid #D3D1C7", borderRadius: 8, padding: "6px 8px" }}>
            <span>{p.flavor}</span>
            <input
              type="number" min={0}
              value={qtyByProduct[p.id] || ""}
              onChange={(e) => setQtyByProduct((q) => ({ ...q, [p.id]: e.target.value }))}
              style={{ width: 48, padding: 4, borderRadius: 6, border: "1px solid #D3D1C7" }}
            />
          </div>
        ))}
      </div>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Total: {fmtBRL(total)}</div>
      {err && <div style={{ color: "#C4394A", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {msg && <div style={{ color: "#27500A", fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <Btn disabled={saving} onClick={handleSave}>{saving ? "Salvando…" : "Lançar pedido"}</Btn>
    </Card>
  );
}

function BellToggle({ role }) {
  const [enabled, setEnabled] = useState(() => isBellEnabled(role));
  function toggle() {
    const next = !enabled;
    setBellEnabled(role, next);
    setEnabled(next);
    if (next) speakAlert("Campainha ativada! Você vai ouvir um aviso a cada novo pedido.");
  }
  return (
    <Btn variant={enabled ? "dark" : "ghost"} style={{ padding: "6px 14px", fontSize: 13 }} onClick={toggle}>
      {enabled ? "🔔 Campainha ativada" : "🔕 Ativar campainha"}
    </Btn>
  );
}

// ---------- Fabricante ----------
function Fabricante({ orders, products, stock, resellers, chats, currentEmail, onUpdateStatus, onApproveReseller, onRejectReseller, onToggleProduct, onDeleteOrder, onManualResellerToggle, onMarkPaymentReceived, onCreateTestOrder, onSendChatMessage }) {
  const [tab, setTab] = useState("pedidos");
  const sorted = [...orders].sort((a, b) => new Date(b.date) - new Date(a.date));
  const lowStock = stock.filter((s) => s.qty <= s.min);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn variant={tab === "pedidos" ? "dark" : "ghost"} onClick={() => setTab("pedidos")}>Pedidos</Btn>
          <Btn variant={tab === "estoque" ? "dark" : "ghost"} onClick={() => setTab("estoque")}>
            Estoque{lowStock.length > 0 && ` (${lowStock.length} em falta)`}
          </Btn>
          <Btn variant={tab === "administracao" ? "dark" : "ghost"} onClick={() => setTab("administracao")}>Administração</Btn>
          <Btn variant={tab === "chat" ? "dark" : "ghost"} onClick={() => setTab("chat")}>Chat</Btn>
          <BellToggle role="fabricante" />
        </div>
        {tab === "pedidos" && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" onClick={() => downloadCSV("pedidos.csv", [
              ["Data", "Cliente", "Perfil", "Itens", "Total", "Endereço", "WhatsApp", "Status"],
              ...sorted.map((o) => [new Date(o.date).toLocaleString("pt-BR"), o.email, o.role, o.items.map((i) => `${i.qty}x ${i.flavor}`).join("; "), o.total.toFixed(2), o.address, o.whatsapp, o.status]),
            ])}>Exportar XLSX/CSV</Btn>
            <Btn variant="ghost" onClick={() => printReport("Relatório de pedidos", [
              ["Data", "Cliente", "Itens", "Total", "Status"],
              ...sorted.map((o) => [new Date(o.date).toLocaleString("pt-BR"), o.email, o.items.map((i) => `${i.qty}x ${i.flavor}`).join("; "), fmtBRL(o.total), o.status]),
            ])}>Imprimir PDF</Btn>
          </div>
        )}
      </div>

      {tab === "estoque" && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 10, color: "#3D2419" }}>Ingredientes disponíveis</div>
          <div style={{ fontSize: 12, color: "#8A7A63", marginBottom: 12 }}>
            Visualização apenas para consulta — ajustes de quantidade são feitos no controle de estoque.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stock.map((s) => (
              <div key={s.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, alignItems: "center", fontSize: 13 }}>
                <span style={{ color: s.qty <= s.min ? "#C4394A" : "#2C2C2A" }}>{s.name}{s.qty <= s.min && " ⚠ em falta"}</span>
                <span style={{ color: "#8A7A63", textAlign: "right" }}>{s.qty} {s.unit} <span style={{ color: "#B4B2A9" }}>(mín {s.min})</span></span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "administracao" && (
        <Adm
          orders={orders}
          products={products}
          stock={stock}
          resellers={resellers}
          onApproveReseller={onApproveReseller}
          onRejectReseller={onRejectReseller}
          onToggleProduct={onToggleProduct}
          onDeleteOrder={onDeleteOrder}
          onUpdateStatus={onUpdateStatus}
          onManualResellerToggle={onManualResellerToggle}
          onMarkPaymentReceived={onMarkPaymentReceived}
          onCreateTestOrder={onCreateTestOrder}
        />
      )}

      {tab === "chat" && (
        <ChatPanel chats={chats} orders={orders} onSend={(clientEmail, text) => onSendChatMessage(clientEmail, "fabricante", currentEmail, text)} />
      )}

      {tab === "pedidos" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.length === 0 && <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhum pedido ainda.</div>}
        {sorted.map((o) => (
          <Card key={o.id}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <Avatar email={o.email} size={32} />
                <div>
                  <div style={{ fontWeight: 700, color: "#3D2419" }}>{o.email} <Badge tone={o.role === "revenda" ? "rose" : "gray"}>{o.role}</Badge>{o.orderType && <Badge tone={o.orderType === "reposicao" ? "rose" : "gray"}>{o.orderType === "reposicao" ? "reposição" : "novo pedido"}</Badge>}{o.isTest && <Badge tone="gold">🔔 teste</Badge>}</div>
                  <div style={{ fontSize: 12, color: "#8A7A63" }}>{new Date(o.date).toLocaleString("pt-BR")} · {o.address} · {o.whatsapp}</div>
                </div>
              </div>
              <StatusBadge status={o.status} />
            </div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {o.items.map((it, i) => <div key={i}>{it.qty}x Brownie {it.flavor} — {fmtBRL(it.unitPrice)}</div>)}
            </div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{fmtBRL(o.total)}</div>
            {o.deliveryPhoto && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <img src={o.deliveryPhoto} alt="Foto da entrega" style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover" }} />
                <span style={{ fontSize: 12, color: "#8A7A63" }}>Foto de confirmação enviada pelo cliente</span>
              </div>
            )}
            {o.paymentMethod === "Pix" && o.paymentProof && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <img src={o.paymentProof} alt="Comprovante Pix" style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover" }} />
                <span style={{ fontSize: 12, color: "#8A7A63" }}>Comprovante Pix do cliente</span>
              </div>
            )}
            {o.paymentType === "consignado" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#8A7A63" }}>Consignado · vence em {new Date(o.paymentDueDate).toLocaleDateString("pt-BR")}</span>
                <Badge tone={o.paymentStatus === "pago" ? "green" : "gold"}>{o.paymentStatus === "pago" ? "pago" : "pagamento pendente"}</Badge>
                {o.paymentStatus !== "pago" && (
                  <Btn variant="ghost" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => onMarkPaymentReceived(o.id)}>Marcar pagamento recebido</Btn>
                )}
              </div>
            )}
            {o.salesReport && (
              <div style={{ marginBottom: 8, fontSize: 12, color: "#8A7A63" }}>
                <div style={{ fontWeight: 700, color: "#3D2419" }}>Vendas informadas pelo revendedor</div>
                {o.salesReport.items.map((it) => <div key={it.productId}>{it.flavor}: {it.vendidos} vendidos, {it.restantes} restantes</div>)}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                value={o.status}
                onChange={(e) => onUpdateStatus(o.id, e.target.value)}
                style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }}
              >
                {[...STATUS_FLOW, STATUS_CANCELLED].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <Btn variant="danger" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => onDeleteOrder(o.id)}>Excluir</Btn>
            </div>
          </Card>
        ))}
      </div>
      )}
    </div>
  );
}

// ---------- Estoque ----------
function Estoque({ stock, products, onUpdateStock, onAddIngredient, onRemoveIngredient, onToggleProduct }) {
  const [newIng, setNewIng] = useState({ name: "", qty: "", unit: "kg", min: "" });
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 14 }}>
        <Btn variant="ghost" onClick={() => downloadCSV("estoque.csv", [
          ["Ingrediente", "Quantidade", "Unidade", "Mínimo"],
          ...stock.map((s) => [s.name, s.qty, s.unit, s.min]),
        ])}>Exportar XLSX/CSV</Btn>
        <Btn variant="ghost" onClick={() => printReport("Relatório de estoque", [
          ["Ingrediente", "Quantidade", "Unidade", "Mínimo"],
          ...stock.map((s) => [s.name, s.qty, s.unit, s.min]),
        ])}>Imprimir PDF</Btn>
      </div>

      <Card style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#3D2419" }}>Ingredientes</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {stock.map((s) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 8, alignItems: "center", fontSize: 13 }}>
              <span style={{ color: s.qty <= s.min ? "#C4394A" : "#2C2C2A" }}>{s.name}{s.qty <= s.min && " ⚠"}</span>
              <input type="number" value={s.qty} onChange={(e) => onUpdateStock(s.id, { qty: Number(e.target.value) })} style={{ padding: 6, borderRadius: 6, border: "1px solid #D3D1C7" }} />
              <span style={{ color: "#8A7A63" }}>{s.unit} · mín {s.min}</span>
              <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onRemoveIngredient(s.id)}>Remover</Btn>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, marginTop: 14 }}>
          <input placeholder="Novo ingrediente" value={newIng.name} onChange={(e) => setNewIng({ ...newIng, name: e.target.value })} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
          <input placeholder="Qtd" type="number" value={newIng.qty} onChange={(e) => setNewIng({ ...newIng, qty: e.target.value })} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
          <input placeholder="Unidade" value={newIng.unit} onChange={(e) => setNewIng({ ...newIng, unit: e.target.value })} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
          <input placeholder="Mínimo" type="number" value={newIng.min} onChange={(e) => setNewIng({ ...newIng, min: e.target.value })} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
          <Btn onClick={() => {
            if (!newIng.name.trim()) return;
            onAddIngredient({ id: uid(), name: newIng.name, qty: Number(newIng.qty) || 0, unit: newIng.unit || "un", min: Number(newIng.min) || 0 });
            setNewIng({ name: "", qty: "", unit: "kg", min: "" });
          }}>Adicionar</Btn>
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#3D2419" }}>Produtos (sabores de brownie)</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {products.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <span>Brownie {p.flavor}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Badge tone={p.active ? "green" : "gray"}>{p.active ? "ativo" : "inativo"}</Badge>
                <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onToggleProduct(p.id)}>{p.active ? "Desativar" : "Ativar"}</Btn>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---------- Adm ----------
function Adm({ orders, products, stock, resellers, chats, currentEmail, onApproveReseller, onRejectReseller, onToggleProduct, onDeleteOrder, onUpdateStatus, onManualResellerToggle, onMarkPaymentReceived, onCreateTestOrder, onSendChatMessage }) {
  const [tab, setTab] = useState("visao");
  const [clientSearch, setClientSearch] = useState("");
  const [showManualTools, setShowManualTools] = useState(false);
  const pendingResellers = resellers.filter((r) => r.status === "pendente");
  const activeResellers = resellers.filter((r) => r.status === "ativo");
  const totalFaturado = orders.filter((o) => o.status !== STATUS_CANCELLED).reduce((s, o) => s + o.total, 0);
  const lowStock = stock.filter((s) => s.qty <= s.min);

  const clientsList = useMemo(() => {
    const map = {};
    orders.forEach((o) => {
      if (!map[o.email]) map[o.email] = { email: o.email, orders: 0, total: 0, lastOrder: null, address: "", whatsapp: "" };
      const c = map[o.email];
      c.orders += 1;
      if (o.status !== STATUS_CANCELLED) c.total += o.total;
      if (!c.lastOrder || new Date(o.date) > new Date(c.lastOrder)) {
        c.lastOrder = o.date;
        c.address = o.address;
        c.whatsapp = o.whatsapp;
      }
    });
    resellers.forEach((r) => {
      if (!map[r.email]) map[r.email] = { email: r.email, orders: 0, total: 0, lastOrder: null, address: "", whatsapp: "" };
    });
    return Object.values(map)
      .map((c) => {
        const r = resellers.find((x) => x.email === c.email);
        return { ...c, resellerStatus: r ? r.status : "cliente final", unitsThisMonth: r ? r.unitsThisMonth : 0 };
      })
      .filter((c) => c.email.toLowerCase().includes(clientSearch.trim().toLowerCase()))
      .sort((a, b) => (b.lastOrder ? new Date(b.lastOrder) : 0) - (a.lastOrder ? new Date(a.lastOrder) : 0));
  }, [orders, resellers, clientSearch]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <Btn variant={tab === "visao" ? "dark" : "ghost"} onClick={() => setTab("visao")}>Visão geral</Btn>
        <Btn variant={tab === "clientes" ? "dark" : "ghost"} onClick={() => setTab("clientes")}>Clientes e revendedores</Btn>
        <Btn variant={tab === "revendas" ? "dark" : "ghost"} onClick={() => setTab("revendas")}>Revendas ({pendingResellers.length} pendentes)</Btn>
        <Btn variant={tab === "produtos" ? "dark" : "ghost"} onClick={() => setTab("produtos")}>Produtos</Btn>
        <Btn variant={tab === "pedidos" ? "dark" : "ghost"} onClick={() => setTab("pedidos")}>Pedidos</Btn>
        <Btn variant={tab === "chat" ? "dark" : "ghost"} onClick={() => setTab("chat")}>Chat</Btn>
        <BellToggle role="adm" />
      </div>

      {tab === "chat" && (
        <ChatPanel chats={chats} orders={orders} onSend={(clientEmail, text) => onSendChatMessage(clientEmail, "adm", currentEmail, text)} />
      )}

      {tab === "visao" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Faturamento total</div><div style={{ fontSize: 22, fontWeight: 700, color: "#3D2419" }}>{fmtBRL(totalFaturado)}</div></Card>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Pedidos</div><div style={{ fontSize: 22, fontWeight: 700, color: "#3D2419" }}>{orders.length}</div></Card>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Revendedores ativos</div><div style={{ fontSize: 22, fontWeight: 700, color: "#3D2419" }}>{activeResellers.length}</div></Card>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Ingredientes em falta</div><div style={{ fontSize: 22, fontWeight: 700, color: lowStock.length ? "#C4394A" : "#3D2419" }}>{lowStock.length}</div></Card>
          <Card>
            <div style={{ fontSize: 12, color: "#8A7A63", marginBottom: 8 }}>Testar o aviso sonoro de novo pedido (ative a campainha no topo da tela antes)</div>
            <Btn variant="ghost" style={{ width: "100%" }} onClick={onCreateTestOrder}>🔔 Campainha de teste</Btn>
          </Card>
        </div>
      )}

      {tab === "clientes" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <input
              placeholder="Buscar por e-mail"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7", minWidth: 220 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" onClick={() => downloadCSV("clientes_revendedores.csv", [
                ["E-mail", "Pedidos", "Total gasto", "Status", "Unidades no mês", "Último endereço", "WhatsApp", "Última compra"],
                ...clientsList.map((c) => [c.email, c.orders, c.total.toFixed(2), c.resellerStatus, c.unitsThisMonth, c.address, c.whatsapp, c.lastOrder ? new Date(c.lastOrder).toLocaleString("pt-BR") : ""]),
              ])}>Exportar XLSX/CSV</Btn>
              <Btn variant="ghost" onClick={() => printReport("Clientes e revendedores", [
                ["E-mail", "Pedidos", "Total gasto", "Status", "Última compra"],
                ...clientsList.map((c) => [c.email, c.orders, fmtBRL(c.total), c.resellerStatus, c.lastOrder ? new Date(c.lastOrder).toLocaleString("pt-BR") : ""]),
              ])}>Imprimir PDF</Btn>
              <Btn variant="ghost" onClick={() => setShowManualTools((v) => !v)}>
                {showManualTools ? "Fechar" : "+ Cliente / pedido antigo"}
              </Btn>
            </div>
          </div>

          {showManualTools && (
            <div>
              <ManualClienteForm />
              <ManualOrderForm products={products} />
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {clientsList.length === 0 && <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhum cliente encontrado.</div>}
            {clientsList.map((c) => (
              <Card key={c.email}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Avatar email={c.email} size={36} />
                    <div>
                      <div style={{ fontWeight: 700, color: "#3D2419" }}>{c.email}</div>
                      <div style={{ fontSize: 12, color: "#8A7A63" }}>
                        {c.orders} pedido(s) · {fmtBRL(c.total)} gastos · {c.address || "sem endereço registrado"} {c.whatsapp && `· ${c.whatsapp}`}
                      </div>
                      <div style={{ fontSize: 12, color: "#8A7A63" }}>
                        {c.lastOrder ? `Última compra: ${new Date(c.lastOrder).toLocaleDateString("pt-BR")}` : "Sem compras ainda"}
                        {c.resellerStatus !== "cliente final" && ` · Unidades no mês: ${c.unitsThisMonth}/${RESELLER_THRESHOLD}`}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Badge tone={c.resellerStatus === "ativo" ? "green" : c.resellerStatus === "pendente" ? "gold" : "gray"}>
                      {c.resellerStatus === "cliente final" ? "cliente final" : `revenda: ${c.resellerStatus}`}
                    </Badge>
                    <Btn
                      variant="ghost"
                      style={{ padding: "4px 10px", fontSize: 12 }}
                      onClick={() => onManualResellerToggle(c.email, c.resellerStatus === "ativo" ? "inativo" : "ativo")}
                    >
                      {c.resellerStatus === "ativo" ? "Remover revenda" : "Tornar revendedor(a)"}
                    </Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {tab === "revendas" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {resellers.length === 0 && <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhuma solicitação ainda.</div>}
          {resellers.map((r) => (
            <Card key={r.email}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{r.email}</div>
                  <div style={{ fontSize: 12, color: "#8A7A63" }}>Unidades no mês: {r.unitsThisMonth} / {RESELLER_THRESHOLD} · Solicitado em {new Date(r.requestedAt).toLocaleDateString("pt-BR")}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Badge tone={r.status === "ativo" ? "green" : r.status === "pendente" ? "gold" : "gray"}>{r.status}</Badge>
                  {r.status === "pendente" && (
                    <>
                      <Btn onClick={() => onApproveReseller(r.email)}>Aprovar</Btn>
                      <Btn variant="ghost" onClick={() => onRejectReseller(r.email)}>Recusar</Btn>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "produtos" && (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {products.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <span>Brownie {p.flavor}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Badge tone={p.active ? "green" : "gray"}>{p.active ? "ativo" : "inativo"}</Badge>
                  <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onToggleProduct(p.id)}>{p.active ? "Desativar" : "Ativar"}</Btn>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "pedidos" && (
        <div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 14 }}>
            <Btn variant="ghost" onClick={() => downloadCSV("pedidos_adm.csv", [
              ["Data", "Cliente", "Perfil", "Total", "Status"],
              ...orders.map((o) => [new Date(o.date).toLocaleString("pt-BR"), o.email, o.role, o.total.toFixed(2), o.status]),
            ])}>Exportar XLSX/CSV</Btn>
            <Btn variant="ghost" onClick={() => printReport("Relatório geral de pedidos", [
              ["Data", "Cliente", "Total", "Status"],
              ...orders.map((o) => [new Date(o.date).toLocaleString("pt-BR"), o.email, fmtBRL(o.total), o.status]),
            ])}>Imprimir PDF</Btn>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {orders.map((o) => (
              <Card key={o.id}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{o.email} {o.orderType && <Badge tone={o.orderType === "reposicao" ? "rose" : "gray"}>{o.orderType === "reposicao" ? "reposição" : "novo pedido"}</Badge>} {o.isTest && <Badge tone="gold">🔔 teste</Badge>}</div>
                    <div style={{ fontSize: 12, color: "#8A7A63" }}>{new Date(o.date).toLocaleString("pt-BR")} · {fmtBRL(o.total)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <StatusBadge status={o.status} />
                    {o.paymentType === "consignado" && (
                      <Badge tone={o.paymentStatus === "pago" ? "green" : "gold"}>{o.paymentStatus === "pago" ? "pago" : "pagamento pendente"}</Badge>
                    )}
                    {o.paymentType === "consignado" && o.paymentStatus !== "pago" && (
                      <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onMarkPaymentReceived(o.id)}>Marcar pagamento recebido</Btn>
                    )}
                    <Btn variant="danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onDeleteOrder(o.id)}>Excluir</Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeRole, setActiveRole] = useState(null);
  const [products, setProducts] = useState(DEFAULT_PRODUCTS);
  const [orders, setOrders] = useState([]);
  const [resellers, setResellers] = useState([]);
  const [stock, setStock] = useState(DEFAULT_STOCK);
  const [cadastro, setCadastro] = useState(null);
  const [chats, setChats] = useState([]);

  const email = user ? user.email.toLowerCase() : null;

  // Real Google sign-in via Firebase Auth. Role is still decided purely by
  // which Google account's e-mail logged in — fabricante/estoque/adm are
  // just the three accounts that automatically land on their own panel.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthChecked(true);
      if (!u) { setActiveRole(null); return; }
      const v = u.email.toLowerCase();
      setActiveRole(v === ADMIN_EMAIL ? "adm" : v === FABRICANTE_EMAIL ? "fabricante" : v === ESTOQUE_EMAIL ? "estoque" : "cliente");
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!email) return;
    (async () => {
      const data = await loadAll();
      if (data.metanoia_products) setProducts(data.metanoia_products);
      else await save("metanoia_products", DEFAULT_PRODUCTS);
      if (data.metanoia_orders) setOrders(data.metanoia_orders);
      if (data.metanoia_chats) setChats(data.metanoia_chats);
      if (data.metanoia_resellers) setResellers(data.metanoia_resellers);
      if (data.metanoia_stock) setStock(data.metanoia_stock);
      else await save("metanoia_stock", DEFAULT_STOCK);
      setLoading(false);
    })();
  }, [email]);

  // Live sync: reflect what any other viewer (fabricante, admin, another
  // client) writes, so a new order/status/stock change shows up here
  // without a reload.
  useEffect(() => {
    if (!email) return;
    return subscribeAll((key, items) => {
      if (key === "metanoia_products") setProducts(items);
      else if (key === "metanoia_orders") setOrders(items);
      else if (key === "metanoia_chats") setChats(items);
      else if (key === "metanoia_resellers") setResellers(items);
      else if (key === "metanoia_stock") setStock(items);
    });
  }, [email]);

  // Cadastro (pessoa física/jurídica) gate: client/revenda can't check out
  // until this document exists for their e-mail.
  useEffect(() => {
    if (!email) { setCadastro(null); return; }
    return onSnapshot(
      clienteDocRef(email),
      (snap) => setCadastro(snap.exists() ? stripKind(snap.data()) : null),
      (e) => console.error("cadastro subscribe error", e)
    );
  }, [email]);

  // Announce brand-new orders to fabricante/adm with a spoken alert. The
  // ref starts at null so the first population (existing orders loading
  // in) never triggers it — only orders that arrive afterwards do.
  const knownOrderIds = useRef(null);
  useEffect(() => {
    if (knownOrderIds.current === null) {
      knownOrderIds.current = new Set(orders.map((o) => o.id));
      return;
    }
    const isNew = orders.some((o) => !knownOrderIds.current.has(o.id));
    if (isNew && (activeRole === "fabricante" || activeRole === "adm") && isBellEnabled(activeRole)) {
      announceNewOrder();
    }
    knownOrderIds.current = new Set(orders.map((o) => o.id));
  }, [orders, activeRole]);

  const myResellerInfo = useMemo(() => resellers.find((r) => r.email === email), [resellers, email]);

  async function handleLogin() {
    setLoginError("");
    setLoggingIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      console.error("google sign-in error", e);
      if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        setLoginError(`Não foi possível entrar com o Google (${e && e.code ? e.code : "erro desconhecido"}). Tente novamente.`);
      }
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    await signOut(auth);
    setLoading(true);
  }

  async function handlePlaceOrder(order) {
    const next = [...orders, order];
    setOrders(next);
    await saveOrder(order);

    if (order.role === "cliente") {
      const units = order.items.reduce((s, i) => s + i.qty, 0);
      const idx = resellers.findIndex((r) => r.email === order.email);
      let nextResellers = [...resellers];
      if (idx >= 0) {
        const r = { ...nextResellers[idx] };
        const sameMonth = r.lastPurchase && new Date(r.lastPurchase).getMonth() === new Date().getMonth() && new Date(r.lastPurchase).getFullYear() === new Date().getFullYear();
        r.unitsThisMonth = sameMonth ? r.unitsThisMonth + units : units;
        r.lastPurchase = order.date;
        nextResellers[idx] = r;
        setResellers(nextResellers);
        await save("metanoia_resellers", nextResellers);
      }
    }
  }

  async function handleUpdateStatus(orderId, status) {
    const next = orders.map((o) => (o.id === orderId ? { ...o, status } : o));
    setOrders(next);
    await saveOrder(next.find((o) => o.id === orderId));
  }

  async function handleConfirmDelivery(orderId, photoDataUrl) {
    const next = orders.map((o) => (o.id === orderId ? { ...o, status: "Pedido entregue", deliveryPhoto: photoDataUrl } : o));
    setOrders(next);
    await saveOrder(next.find((o) => o.id === orderId));
  }

  async function handleDeleteOrder(orderId) {
    const next = orders.filter((o) => o.id !== orderId);
    setOrders(next);
    await deleteOrderDoc(orderId);
  }

  async function handleCreateTestOrder() {
    const order = {
      id: uid(),
      email: "teste@campainha.com",
      role: "cliente",
      items: [{ productId: "teste", flavor: "Campainha de teste", qty: 1, unitPrice: 0 }],
      total: 0,
      address: "Pedido de teste — pode excluir",
      whatsapp: "-",
      status: STATUS_FLOW[0],
      date: new Date().toISOString(),
      isTest: true,
    };
    setOrders([...orders, order]);
    await saveOrder(order);
  }

  async function handleSendChatMessage(clientEmail, from, senderEmail, text) {
    const msg = { from, email: senderEmail, text, at: new Date().toISOString() };
    const idx = chats.findIndex((c) => c.email === clientEmail);
    let next;
    if (idx >= 0) {
      const updated = { ...chats[idx], messages: [...(chats[idx].messages || []), msg], updatedAt: msg.at };
      next = chats.map((c, i) => (i === idx ? updated : c));
    } else {
      next = [...chats, { email: clientEmail, messages: [msg], updatedAt: msg.at }];
    }
    setChats(next);
    await sendChatMessage(clientEmail, from, senderEmail, text);
  }

  async function handleMarkPaymentReceived(orderId) {
    const target = orders.find((o) => o.id === orderId);
    if (!target) return;
    const updated = { ...target, paymentStatus: "pago" };
    setOrders(orders.map((o) => (o.id === orderId ? updated : o)));
    await saveOrder(updated);
  }

  async function handleSubmitSalesReport(orderId, items) {
    const target = orders.find((o) => o.id === orderId);
    if (!target) return;
    const updated = { ...target, salesReport: { items, reportedAt: new Date().toISOString() } };
    setOrders(orders.map((o) => (o.id === orderId ? updated : o)));
    await saveOrder(updated);
  }

  async function handleRequestReseller(em) {
    const next = [...resellers.filter((r) => r.email !== em), { email: em, status: "pendente", unitsThisMonth: 0, requestedAt: new Date().toISOString(), lastPurchase: null }];
    setResellers(next);
    await save("metanoia_resellers", next);
  }

  async function handleApproveReseller(em) {
    const next = resellers.map((r) => (r.email === em ? { ...r, status: "ativo", activatedAt: new Date().toISOString() } : r));
    setResellers(next);
    await save("metanoia_resellers", next);
  }

  async function handleRejectReseller(em) {
    const next = resellers.map((r) => (r.email === em ? { ...r, status: "inativo" } : r));
    setResellers(next);
    await save("metanoia_resellers", next);
  }

  async function handleManualResellerToggle(em, status) {
    const exists = resellers.find((r) => r.email === em);
    let next;
    if (exists) {
      next = resellers.map((r) => (r.email === em ? { ...r, status, ...(status === "ativo" ? { activatedAt: new Date().toISOString() } : {}) } : r));
    } else {
      next = [...resellers, { email: em, status, unitsThisMonth: 0, requestedAt: new Date().toISOString(), lastPurchase: null, activatedAt: status === "ativo" ? new Date().toISOString() : null }];
    }
    setResellers(next);
    await save("metanoia_resellers", next);
  }

  async function handleUpdateStock(id, patch) {
    const next = stock.map((s) => (s.id === id ? { ...s, ...patch } : s));
    setStock(next);
    await save("metanoia_stock", next);
  }
  async function handleAddIngredient(ing) {
    const next = [...stock, ing];
    setStock(next);
    await save("metanoia_stock", next);
  }
  async function handleRemoveIngredient(id) {
    const next = stock.filter((s) => s.id !== id);
    setStock(next);
    await save("metanoia_stock", next);
  }
  async function handleToggleProduct(id) {
    const next = products.map((p) => (p.id === id ? { ...p, active: !p.active } : p));
    setProducts(next);
    await save("metanoia_products", next);
  }

  // auto-expire resellers past 30 days without purchase
  useEffect(() => {
    if (!resellers.length) return;
    const expired = resellers.filter((r) => r.status === "ativo" && r.lastPurchase && daysAgo(r.lastPurchase) > RESELLER_EXPIRY_DAYS);
    if (expired.length) {
      (async () => {
        const next = resellers.map((r) => (expired.find((e) => e.email === r.email) ? { ...r, status: "inativo", unitsThisMonth: 0 } : r));
        setResellers(next);
        await save("metanoia_resellers", next);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resellers.length]);

  if (!authChecked) {
    return <div style={{ minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#8A7A63" }}>Carregando…</div>;
  }

  if (!user) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#FAF6EF", padding: 24, borderRadius: 16 }}>
        <Login onLogin={handleLogin} loggingIn={loggingIn} loginError={loginError} />
      </div>
    );
  }

  if (loading) {
    return <div style={{ minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#8A7A63" }}>Carregando…</div>;
  }

  const canSwitchToRevenda = myResellerInfo && myResellerInfo.status === "ativo";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#FAF6EF", padding: 24, borderRadius: 16, minHeight: 500 }}>
      <Header email={email} role={activeRole} photoURL={user.photoURL} onLogout={handleLogout} />

      {(activeRole === "cliente" || activeRole === "revenda") && canSwitchToRevenda && email !== ADMIN_EMAIL && email !== FABRICANTE_EMAIL && email !== ESTOQUE_EMAIL && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <Btn variant={activeRole === "cliente" ? "dark" : "ghost"} onClick={() => setActiveRole("cliente")} style={{ padding: "6px 14px", fontSize: 13 }}>Acesso cliente</Btn>
          <Btn variant={activeRole === "revenda" ? "dark" : "ghost"} onClick={() => setActiveRole("revenda")} style={{ padding: "6px 14px", fontSize: 13 }}>Acesso revenda</Btn>
        </div>
      )}

      {(activeRole === "cliente" || activeRole === "revenda") && (
        <Storefront
          email={email}
          role={activeRole}
          products={products}
          orders={orders}
          resellerInfo={myResellerInfo}
          cadastro={cadastro}
          onSaveCadastro={(data) => saveCliente(email, data)}
          onPlaceOrder={handlePlaceOrder}
          onRequestReseller={handleRequestReseller}
          onConfirmDelivery={handleConfirmDelivery}
          onSubmitSalesReport={handleSubmitSalesReport}
          chats={chats}
          onSendChatMessage={handleSendChatMessage}
        />
      )}

      {activeRole === "fabricante" && (
        <Fabricante
          orders={orders}
          products={products}
          stock={stock}
          resellers={resellers}
          onUpdateStatus={handleUpdateStatus}
          onApproveReseller={handleApproveReseller}
          onRejectReseller={handleRejectReseller}
          onToggleProduct={handleToggleProduct}
          onDeleteOrder={handleDeleteOrder}
          onManualResellerToggle={handleManualResellerToggle}
          onMarkPaymentReceived={handleMarkPaymentReceived}
          onCreateTestOrder={handleCreateTestOrder}
          chats={chats}
          currentEmail={email}
          onSendChatMessage={handleSendChatMessage}
        />
      )}

      {activeRole === "adm" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Btn variant="ghost" onClick={() => setActiveRole("estoque")} style={{ padding: "6px 14px", fontSize: 13 }}>Ir para controle de estoque</Btn>
          </div>
          <Adm
            orders={orders}
            products={products}
            stock={stock}
            resellers={resellers}
            onApproveReseller={handleApproveReseller}
            onRejectReseller={handleRejectReseller}
            onToggleProduct={handleToggleProduct}
            onDeleteOrder={handleDeleteOrder}
            onUpdateStatus={handleUpdateStatus}
            onManualResellerToggle={handleManualResellerToggle}
            onMarkPaymentReceived={handleMarkPaymentReceived}
            onCreateTestOrder={handleCreateTestOrder}
            chats={chats}
            currentEmail={email}
            onSendChatMessage={handleSendChatMessage}
          />
        </div>
      )}

      {activeRole === "estoque" && (
        <div>
          {email === ADMIN_EMAIL && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <Btn variant="ghost" onClick={() => setActiveRole("adm")} style={{ padding: "6px 14px", fontSize: 13 }}>Voltar ao painel adm</Btn>
            </div>
          )}
          <Estoque
            stock={stock}
            products={products}
            onUpdateStock={handleUpdateStock}
            onAddIngredient={handleAddIngredient}
            onRemoveIngredient={handleRemoveIngredient}
            onToggleProduct={handleToggleProduct}
          />
        </div>
      )}
    </div>
  );
}
