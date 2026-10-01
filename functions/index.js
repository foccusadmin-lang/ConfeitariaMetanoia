const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");

// Creates a Mercado Pago payment (Pix or card) server-side, where the
// Access Token can stay secret. The client only ever sees the Public Key
// and whatever Mercado Pago's Payment Brick itself returns (a card token,
// never the raw card number).
exports.createPayment = onCall({ secrets: [MP_ACCESS_TOKEN], region: "us-central1", cors: true }, async (request) => {
  const data = request.data || {};
  const { amount, email, orderId, paymentMethodId, token, installments, issuerId, docType, docNumber } = data;

  if (!amount || !email || !orderId || !paymentMethodId) {
    throw new HttpsError("invalid-argument", "Dados do pagamento incompletos.");
  }

  const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN.value() });
  const payment = new Payment(client);

  const payer = { email };
  if (docType && docNumber) payer.identification = { type: docType, number: docNumber };

  const body = {
    transaction_amount: Number(amount),
    description: "Pedido Doceria Metanoia " + orderId,
    payment_method_id: paymentMethodId,
    external_reference: orderId,
    payer,
  };

  if (paymentMethodId !== "pix") {
    if (!token) throw new HttpsError("invalid-argument", "Token do cartão ausente.");
    body.token = token;
    body.installments = Number(installments) || 1;
    if (issuerId) body.issuer_id = issuerId;
  }

  try {
    const result = await payment.create({ body, requestOptions: { idempotencyKey: orderId } });
    return {
      id: result.id,
      status: result.status,
      status_detail: result.status_detail,
      qr_code: result.point_of_interaction?.transaction_data?.qr_code || null,
      qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64 || null,
    };
  } catch (e) {
    console.error("mercadopago payment error", e && e.message ? e.message : e);
    throw new HttpsError("internal", "Não foi possível processar o pagamento.");
  }
});

// Lets the client poll a payment's current status (e.g. while waiting for
// a Pix to be paid) without needing the Access Token itself.
exports.getPaymentStatus = onCall({ secrets: [MP_ACCESS_TOKEN], region: "us-central1", cors: true }, async (request) => {
  const { paymentId } = request.data || {};
  if (!paymentId) throw new HttpsError("invalid-argument", "paymentId ausente.");

  const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN.value() });
  const payment = new Payment(client);

  try {
    const result = await payment.get({ id: paymentId });
    return { id: result.id, status: result.status, status_detail: result.status_detail };
  } catch (e) {
    console.error("mercadopago status error", e && e.message ? e.message : e);
    throw new HttpsError("internal", "Não foi possível consultar o pagamento.");
  }
});
