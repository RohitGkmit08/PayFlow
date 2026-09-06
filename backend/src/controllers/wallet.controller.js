const { addMoneySchema } = require("../validator/addMoney.validator.js");
const { addMoney: addMoneyService } = require("../services/wallet.service.js");

const addMoney = async (req, res) => {
    try {
        const result = addMoneySchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                message: "Invalid add-money data",
                errors: result.error.issues
            });
        }

        const { amount } = result.data;

        const transaction = await addMoneyService({
            userId: req.userId,
            amount
        });

        return res.status(201).json({
            message: "Money added successfully",
            transaction: {
                id: transaction.transactionId,
                type: transaction.type,
                amount: transaction.amount,
                currency: transaction.currency,
                status: transaction.status
            }
        });

    } catch (err) {
        return res.status(500).json({
            message: err.message || "Internal server error"
        });
    }
};

module.exports = {addMoney};