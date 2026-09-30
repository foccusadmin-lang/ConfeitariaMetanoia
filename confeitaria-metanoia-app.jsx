import { useState, useEffect, useMemo } from "react";
import { db } from "./src/firebase.js";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";

const ADMIN_EMAIL = "wdgraficarapidacv@gmail.com";
const FABRICANTE_EMAIL = "nelcialves016@gmail.com";
const ESTOQUE_EMAIL = "evvuldconfeitaria@gmail.com";
const PRICE_REVENDA = 6.5;
const PRICE_CLIENTE = 12.0;
const RESELLER_THRESHOLD = 30;
const RESELLER_EXPIRY_DAYS = 30;

const FLAVOR_COLORS = {
  "Maracujá": "#E8A23D",
  "Doce de Leite": "#B06B3A",
  "Ninho": "#D8C6A8",
  "Nutella": "#5B3A29",
  "Ninho com Nutella": "#8A5B3F",
  "Brigadeiro": "#3D2419",
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

// Data lives in Firestore under metanoia/{products,orders,resellers,stock},
// each document holding { items: [...] }. Every viewer (client, fabricante,
// admin) reads and writes the same shared documents in real time.
const STORAGE_KEYS = ["metanoia_products", "metanoia_orders", "metanoia_resellers", "metanoia_stock"];

function docRef(key) {
  return doc(db, "metanoia", key);
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
  return out;
}
async function save(key, value) {
  try {
    await setDoc(docRef(key), { items: value });
  } catch (e) {
    console.error("storage write error", e);
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
        <Btn variant="ghost" onClick={onLogout} style={{ padding: "6px 14px", fontSize: 13 }}>Sair</Btn>
      </div>
    </div>
  );
}

// ---------- Login ----------
function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  return (
    <div style={{ minHeight: 480, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Card style={{ width: 340, textAlign: "center" }}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 30, color: "#3D2419", fontWeight: 700, marginBottom: 2 }}>Metanoia</div>
        <div style={{ fontSize: 13, color: "#8A7A63", marginBottom: 22 }}>Adoçando a vida — brownies artesanais</div>
        <div style={{ textAlign: "left", marginBottom: 6, fontSize: 13, color: "#5F5E5A" }}>E-mail (Google, Hotmail ou iCloud)</div>
        <input
          type="email"
          value={email}
          placeholder="seuemail@exemplo.com"
          onChange={(e) => { setEmail(e.target.value); setErr(""); }}
          style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #D3D1C7", fontSize: 14, marginBottom: 10, boxSizing: "border-box" }}
        />
        {email.includes("@") && (
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <Avatar email={email} size={40} />
          </div>
        )}
        {err && <div style={{ color: "#C4394A", fontSize: 12, marginBottom: 10 }}>{err}</div>}
        <Btn
          style={{ width: "100%" }}
          onClick={() => {
            const v = email.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setErr("Digite um e-mail válido."); return; }
            onLogin(v);
          }}
        >
          Entrar
        </Btn>
        <div style={{ fontSize: 11, color: "#B4B2A9", marginTop: 14 }}>
          Protótipo: login simulado por e-mail (sem senha). Os e-mails de fabricante, estoque e adm abrem seus painéis automaticamente.
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

function Storefront({ email, role, products, orders, resellerInfo, onPlaceOrder, onRequestReseller, onConfirmDelivery }) {
  const [cart, setCart] = useState({});
  const [addr, setAddr] = useState("");
  const [whats, setWhats] = useState("");
  const [tab, setTab] = useState("loja");

  const price = role === "revenda" ? PRICE_REVENDA : PRICE_CLIENTE;
  const activeProducts = products.filter((p) => p.active);
  const cartItems = Object.entries(cart).filter(([, q]) => q > 0);
  const total = cartItems.reduce((s, [, q]) => s + q * price, 0);
  const myOrders = orders.filter((o) => o.email === email).sort((a, b) => new Date(b.date) - new Date(a.date));

  const canRequestReseller = role === "cliente" && (!resellerInfo || resellerInfo.status === "inativo");
  const pendingRequest = resellerInfo && resellerInfo.status === "pendente";

  function addQty(id, delta) {
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] || 0) + delta) }));
  }

  function checkout() {
    if (cartItems.length === 0) return;
    if (!addr.trim() || !whats.trim()) { alert("Preencha endereço e WhatsApp para finalizar o pedido."); return; }
    onPlaceOrder({
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
    });
    setCart({});
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, gap: 10 }}>
        <CartIcon count={cartItems.reduce((s, [, q]) => s + q, 0)} onClick={() => setTab("loja")} />
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant={tab === "loja" ? "dark" : "ghost"} onClick={() => setTab("loja")}>Painel</Btn>
          <Btn variant={tab === "pedidos" ? "dark" : "ghost"} onClick={() => setTab("pedidos")}>Meus pedidos ({myOrders.length})</Btn>
        </div>
      </div>

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
                <div style={{ width: "100%", height: 90, borderRadius: 10, background: FLAVOR_COLORS[p.flavor], marginBottom: 10 }} />
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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
                  <input placeholder="Endereço de entrega" value={addr} onChange={(e) => setAddr(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
                  <input placeholder="WhatsApp" value={whats} onChange={(e) => setWhats(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }} />
                </div>
                <Btn style={{ marginTop: 12, width: "100%" }} onClick={checkout}>Finalizar pedido</Btn>
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
                <span style={{ fontSize: 12, color: "#8A7A63" }}>{new Date(o.date).toLocaleString("pt-BR")}</span>
                <StatusBadge status={o.status} />
              </div>
              <div style={{ fontSize: 13 }}>
                {o.items.map((it, i) => <div key={i}>{it.qty}x Brownie {it.flavor}</div>)}
              </div>
              <div style={{ fontWeight: 700, marginTop: 6 }}>{fmtBRL(o.total)}</div>
              <DeliveryConfirm order={o} onConfirmDelivery={onConfirmDelivery} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Fabricante ----------
function Fabricante({ orders, products, stock, onUpdateStatus }) {
  const [tab, setTab] = useState("pedidos");
  const sorted = [...orders].sort((a, b) => new Date(b.date) - new Date(a.date));
  const lowStock = stock.filter((s) => s.qty <= s.min);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant={tab === "pedidos" ? "dark" : "ghost"} onClick={() => setTab("pedidos")}>Pedidos</Btn>
          <Btn variant={tab === "estoque" ? "dark" : "ghost"} onClick={() => setTab("estoque")}>
            Estoque{lowStock.length > 0 && ` (${lowStock.length} em falta)`}
          </Btn>
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

      {tab === "pedidos" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.length === 0 && <div style={{ fontSize: 13, color: "#8A7A63" }}>Nenhum pedido ainda.</div>}
        {sorted.map((o) => (
          <Card key={o.id}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <Avatar email={o.email} size={32} />
                <div>
                  <div style={{ fontWeight: 700, color: "#3D2419" }}>{o.email} <Badge tone={o.role === "revenda" ? "rose" : "gray"}>{o.role}</Badge></div>
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                value={o.status}
                onChange={(e) => onUpdateStatus(o.id, e.target.value)}
                style={{ padding: 8, borderRadius: 8, border: "1px solid #D3D1C7" }}
              >
                {[...STATUS_FLOW, STATUS_CANCELLED].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
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
function Adm({ orders, products, stock, resellers, onApproveReseller, onRejectReseller, onToggleProduct, onDeleteOrder, onUpdateStatus, onManualResellerToggle }) {
  const [tab, setTab] = useState("visao");
  const [clientSearch, setClientSearch] = useState("");
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
      </div>

      {tab === "visao" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Faturamento total</div><div style={{ fontSize: 22, fontWeight: 700, color: "#3D2419" }}>{fmtBRL(totalFaturado)}</div></Card>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Pedidos</div><div style={{ fontSize: 22, fontWeight: 700, color: "#3D2419" }}>{orders.length}</div></Card>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Revendedores ativos</div><div style={{ fontSize: 22, fontWeight: 700, color: "#3D2419" }}>{activeResellers.length}</div></Card>
          <Card><div style={{ fontSize: 12, color: "#8A7A63" }}>Ingredientes em falta</div><div style={{ fontSize: 22, fontWeight: 700, color: lowStock.length ? "#C4394A" : "#3D2419" }}>{lowStock.length}</div></Card>
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
            </div>
          </div>
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
                    <div style={{ fontWeight: 700 }}>{o.email}</div>
                    <div style={{ fontSize: 12, color: "#8A7A63" }}>{new Date(o.date).toLocaleString("pt-BR")} · {fmtBRL(o.total)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <StatusBadge status={o.status} />
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
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState(null);
  const [activeRole, setActiveRole] = useState(null);
  const [products, setProducts] = useState(DEFAULT_PRODUCTS);
  const [orders, setOrders] = useState([]);
  const [resellers, setResellers] = useState([]);
  const [stock, setStock] = useState(DEFAULT_STOCK);

  useEffect(() => {
    (async () => {
      const data = await loadAll();
      if (data.metanoia_products) setProducts(data.metanoia_products);
      else await save("metanoia_products", DEFAULT_PRODUCTS);
      if (data.metanoia_orders) setOrders(data.metanoia_orders);
      if (data.metanoia_resellers) setResellers(data.metanoia_resellers);
      if (data.metanoia_stock) setStock(data.metanoia_stock);
      else await save("metanoia_stock", DEFAULT_STOCK);
      setLoading(false);
    })();
  }, []);

  // Live sync: reflect what any other viewer (fabricante, admin, another
  // client) writes, so a new order/status/stock change shows up here
  // without a reload.
  useEffect(() => {
    return subscribeAll((key, items) => {
      if (key === "metanoia_products") setProducts(items);
      else if (key === "metanoia_orders") setOrders(items);
      else if (key === "metanoia_resellers") setResellers(items);
      else if (key === "metanoia_stock") setStock(items);
    });
  }, []);

  const myResellerInfo = useMemo(() => resellers.find((r) => r.email === email), [resellers, email]);

  function handleLogin(v) {
    setEmail(v);
    if (v === ADMIN_EMAIL) setActiveRole("adm");
    else if (v === FABRICANTE_EMAIL) setActiveRole("fabricante");
    else if (v === ESTOQUE_EMAIL) setActiveRole("estoque");
    else setActiveRole("cliente");
  }

  async function handlePlaceOrder(order) {
    const next = [...orders, order];
    setOrders(next);
    await save("metanoia_orders", next);

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
    await save("metanoia_orders", next);
  }

  async function handleConfirmDelivery(orderId, photoDataUrl) {
    const next = orders.map((o) => (o.id === orderId ? { ...o, status: "Pedido entregue", deliveryPhoto: photoDataUrl } : o));
    setOrders(next);
    await save("metanoia_orders", next);
  }

  async function handleDeleteOrder(orderId) {
    const next = orders.filter((o) => o.id !== orderId);
    setOrders(next);
    await save("metanoia_orders", next);
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

  if (loading) {
    return <div style={{ minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#8A7A63" }}>Carregando…</div>;
  }

  if (!email) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", background: "#FAF6EF", padding: 24, borderRadius: 16 }}>
        <Login onLogin={handleLogin} />
      </div>
    );
  }

  const canSwitchToRevenda = myResellerInfo && myResellerInfo.status === "ativo";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#FAF6EF", padding: 24, borderRadius: 16, minHeight: 500 }}>
      <Header email={email} role={activeRole} photoURL={null} onLogout={() => { setEmail(null); setActiveRole(null); }} />

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
          onPlaceOrder={handlePlaceOrder}
          onRequestReseller={handleRequestReseller}
          onConfirmDelivery={handleConfirmDelivery}
        />
      )}

      {activeRole === "fabricante" && (
        <Fabricante orders={orders} products={products} stock={stock} onUpdateStatus={handleUpdateStatus} />
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
