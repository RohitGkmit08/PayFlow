require('dotenv').config();

const app = require('./app');
const connectDB = require("./config/db.js")

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`PayFlow API is running on port ${PORT}`);
  });
};

startServer();