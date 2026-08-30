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
    .toLowerCase()
    .email({ message: 'Invalid email address' })
    .optional()
    .or(z.literal('').transform(() => undefined)),

  password: z
    .string()
    .min(6, 'Password must contain at least 6 characters'),
});

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email({ message: 'Invalid email address' })
    .toLowerCase(),
  password: z
    .string()
    .min(1, 'Password is required'),
});

module.exports = {registerSchema, loginSchema};