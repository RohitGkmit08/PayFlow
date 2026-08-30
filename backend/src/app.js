const express = require('express');
const cors = require('cors');

const app = express();
const authRoutes = require("../src/routes/auth.routes.js")

app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes)

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'PayFlow Backend',
    status: 'running',
  });
});

module.exports = app;