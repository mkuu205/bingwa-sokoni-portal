import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const plans = [
    { code: "STARTER", name: "Starter", priceKes: 80, durationDays: 30, maxDevices: 2, transactionHistoryDays: 3 },
    { code: "PRO", name: "Pro", priceKes: 180, durationDays: 30, maxDevices: 5, transactionHistoryDays: 7 },
    { code: "UNLIMITED", name: "Unlimited", priceKes: 350, durationDays: 30, maxDevices: null, transactionHistoryDays: 7 }
  ];
  for (const plan of plans) {
    await prisma.plan.upsert({ where: { code: plan.code }, update: plan, create: plan });
  }
  const phone = process.env.SEED_ADMIN_PHONE;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (phone && password) {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({
      where: { phone },
      update: { passwordHash, role: "ADMIN" },
      create: { phone, passwordHash, role: "ADMIN", phoneVerifiedAt: new Date() }
    });
    console.log(`Seeded admin account for ${phone}. Change the password before production use.`);
  }
}
main().finally(() => prisma.$disconnect());
