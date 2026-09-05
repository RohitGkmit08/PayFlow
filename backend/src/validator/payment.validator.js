const {z} = require("zod");

const paymentSchema = z.object({
    receiverAccountId: z.string().min(1, "reciever account ID is required"),
    amount: z.number().int("amount must be an integer").positive("amount must be greater than 0")
})

module.exports = {paymentSchema};