import { hashPassword } from "../src/lib/auth";
import { prisma } from "../src/lib/db";

const admins = [
  {
    name: "Burak Önal",
    email: "burakonal7@gmail.com",
    password: "20Burak26@+.",
  },
  {
    name: "Ozgur Yilmaz",
    email: "ozgur.yilmaz@crabsmedia.com",
    password: "20Ozgur26@+.",
  },
  {
    name: "Mert Ozturk",
    email: "mert.ozturk@crabsmedia.com",
    password: "20Merd26@+.",
  },
];

async function main() {
  for (const admin of admins) {
    const passwordHash = await hashPassword(admin.password);

    await prisma.user.upsert({
      where: { email: admin.email },
      update: {
        name: admin.name,
        passwordHash,
        role: "SUPER_ADMIN",
        fullAccess: true,
        isActive: true,
      },
      create: {
        name: admin.name,
        email: admin.email,
        passwordHash,
        role: "SUPER_ADMIN",
        fullAccess: true,
        isActive: true,
      },
    });
  }

  console.log("Admin users seeded successfully.");
}

main()
  .catch((error) => {
    console.error("Seeding failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
