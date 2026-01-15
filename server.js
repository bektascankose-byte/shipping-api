import express from "express";
import cors from "cors";
import Stripe from "stripe";
import Shippo from "shippo";

const app = express();
app.use(cors());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const shippoClient = new Shippo({
  apiKey: process.env.SHIPPO_API_KEY
});

/* ======================
   STRIPE WEBHOOK (RAW)
====================== */
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send("Webhook Error");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { orderToken, rateId } = session.metadata;

    await shippoClient.transaction.create({
      rate: rateId,
      label_file_type: "PDF",
      async: false
    });
  }

  res.json({ received: true });
});

/* ======================
   JSON FOR EVERYTHING ELSE
====================== */
app.use(express.json());
app.use(express.static("public"));

app.get("/api/shipping/:orderToken", async (req, res) => {
  try {
    const order = await shippoClient.order.retrieve(req.params.orderToken);
    const shipment = await shippoClient.shipment.retrieve(order.shipments[0]);

    const rates = shipment.rates.map(r => ({
      rate_id: r.object_id,
      carrier: r.provider,
      service: r.servicelevel.name,
      amount: Number(r.amount),
      eta: r.estimated_days
    }));

    res.json({
      customer: {
        name: order.to_address.name,
        city: order.to_address.city,
        state: order.to_address.state
      },
      rates
    });
  } catch {
    res.status(500).json({ error: "Failed to load shipping" });
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { orderToken, rateId } = req.body;

    const order = await shippoClient.order.retrieve(orderToken);
    const shipment = await shippoClient.shipment.retrieve(order.shipments[0]);
    const rate = shipment.rates.find(r => r.object_id === rateId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Shipping – ${rate.provider} ${rate.servicelevel.name}`
          },
          unit_amount: Math.round(rate.amount * 100)
        },
        quantity: 1
      }],
      metadata: { orderToken, rateId },
      success_url: `${process.env.BASE_URL}/shipping-success.html`,
      cancel_url: `${process.env.BASE_URL}/shipping-cancelled.html`
    });

    res.json({ url: session.url });
  } catch {
    res.status(500).json({ error: "Checkout failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
