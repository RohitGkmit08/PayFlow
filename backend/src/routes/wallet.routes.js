const express = require("express");

const authMiddleware = require("../middleware/auth.middleware.js");
const {addMoney} = require("../controllers/wallet.controller.js");

const router = express.Router();

router.post("/add-money", authMiddleware, addMoney);

module.exports = router;