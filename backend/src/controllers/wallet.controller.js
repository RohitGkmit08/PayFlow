const {addMoneySchema} = require("../validator/addMoney.validator.js");

const addMoney = async(req, res) => {
    try{
        const result = addMoneySchema.safeParse(req.body);

        if(!result.success){
            return res.status(400).json({
                message: "Invalid add-money data",
                errors: result.error.issues
            })
        }

        //  service will be added here 

        const {amount} = result.data;

        return res.status(201).json({
            message: "Add money request is valid",
            amount
        })
    }catch(err){
        return res.status(500).json({
            message: err.message || "Internal server error"
        })
    }
}

module.exports = {addMoney};