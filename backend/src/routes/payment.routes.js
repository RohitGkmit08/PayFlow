const express = require("express");

const { createPayment } = require("../controllers/payment.controller.js");

const authMiddleware = require("../middleware/auth.middleware.js");

const router = express.Router();

router.post("/", authMiddleware, createPayment);

module.exports = router;