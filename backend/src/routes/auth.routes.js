const express = require("express");

const router = express.Router();

router.post("/register", (req,res) => {
    res.json({
        message: "registeration endpoint"
    })
})
module.exports = router;