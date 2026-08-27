const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name:{
        tpye:String,
        required:true,
        trim:true
    },
    phone:{
        type:String,
        required:true,
        unique:true,
        trim:true
    },
    email:{
        type:String,
        required:true,
        unique:true,
        trim:true,
        sparse:true,
        // A sparse index only includes documents where the indexed field exists.
        // We're allowing users to not provide an email, while ensuring that an email cannot belong to two users if it is provided.
        lowercase:true
    },

    hashPswd:{
        type:String,
        default:null
    },

    status:{
        type:String,
        enum:['ACTIVE', 'BLOCKED'],
        default:'ACTIVE'
    }
}, {timestamps:true});
module.exports = mongoose.model('User', userSchema);