const {paymentSchema} = require("../validator/payment.validator.js");
const {createP2P} = require("../services/payment.service.js");

const createPayment = async(req, res) => {
    try{
        const result = paymentSchema.safeParse(req.body);

        if(!result.success){
            return res.status(400).json({
                message: "invalid input data",
                errors: result.error.message
            })
        }

        const {receiverAccountId, amount} = req.body;

        const transaction = await createP2P({
            senderUserId: req.userId,
            receiverAccountId,
            amount
        })

        return res.status(200).json({
            message: "payment request validated",
            transaction: {
                id: transaction.transactionId,
                amount: transaction.amount,
                currency: transaction.currency,
                status: transaction.status
            }
        })
        
    }catch(err){
        return res.status(500).json({
            message: "internal serve error"
        })
    }
}

module.exports = {createPayment}