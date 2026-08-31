const crypto = require("crypto");

const Session = require("../models/Session.js")

const authMiddleware = async(req, res, next) => {
    try{
        const {sessionToken} = req.cookies;
        if(!sessionToken){
            return res.status(401).json({
                message: "Authentication required"
            })
        }

        const sessionTokenHash = crypto
        .createHash("sha256")
        .update(sessionToken)
        .digest("hex") 

        const session = await Session.findOne({sessionTokenHash});

        if(!session){
            return res.status(401).json({
                message: "invalid session"
            })
        }

        if (session.expiresAt < new Date()) {
            return res.status(401).json({
                message: "session expired"
            });
        }

        req.userId = session.userId;
        next();

    }catch(err){
        return res.status(500).json({
            message: "internal server error"
        })
    }
}

module.exports = authMiddleware;