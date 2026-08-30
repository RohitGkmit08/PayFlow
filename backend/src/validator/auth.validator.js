const { z } = require('zod');

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Name must contain at least 2 characters'),

  phone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Phone must be a valid 10-digit number'),

  email: z
    .string()
    .trim()
    .email('Invalid email address')
    .toLowerCase(),

  password: z
    .string()
    .min(6, 'Password must contain at least 6 characters'),
});

module.exports = {
  registerSchema,
};