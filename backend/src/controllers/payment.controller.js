const { paymentSchema } = require("../validator/payment.validator.js");
const { createP2P } = require("../services/payment.service.js");

const createPayment = async (req, res) => {

    try {

        /*
         * The client sends the idempotency key as an HTTP header.
         *
         * Example:
         *     Idempotency-Key: ABC123
         *
         * The key is used to identify the same logical payment
         * if the client retries the request.
         */
        const idempotencyKey = req.get("Idempotency-Key");

        /*
         * safeParse() validates the request body without throwing.
         *
         * success = true  → result.data contains validated data
         * success = false → result.error contains validation errors
         */

        const result = paymentSchema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                message: "Invalid input data",
                errors: result.error.issues
            });
        }

        /*
         * Use the validated data returned by Zod rather than
         * reading the original req.body again.
         */

        const { receiverAccountId, amount } = result.data;


        /*
         * The authenticated user's ID comes from authMiddleware.
         *
         * The client does NOT provide senderUserId.
         */
        
        const transaction = await createP2P({
            senderUserId: req.userId,
            receiverAccountId,
            amount,
            idempotencyKey
        });

        return res.status(200).json({
            message: "Payment successful",
            transaction: {
                id: transaction.transactionId,
                amount: transaction.amount,
                currency: transaction.currency,
                status: transaction.status
            }
        });

    } catch (err) {

        if(err.code === "TRANSACTION_COMMIT_UNKNOWN"){
            return res.status(202).json({
            // the server has successfully received and understood your request, but has not yet completed processing it
                message: "payment status could not be confirmed",
                status:"UNKNOWN",
                transactionId: err.transactionId
            })

        }
        return res.status(500).json({
            message: "Internal server error"
        });
    }
};

module.exports = { createPayment };

