const express = require('express');
const cors = require('cors');

const app = express();
const authRoutes = require("../src/routes/auth.routes.js");
const paymentRoutes = require("../src/routes/payment.routes.js");
const walletRoutes = require("../src/routes/wallet.routes.js")
const cookieParser = require("cookie-parser");

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/wallet", walletRoutes);

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'PayFlow Backend',
    status: 'running',
  });
});

module.exports = app;