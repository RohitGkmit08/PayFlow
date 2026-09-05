const {z} = require("zod");

const addMoneySchema = z.object({
    amount:z.number().int("Number must be positive").positive("amount must be greater than 0")
})

module.exports = {addMoneySchema};