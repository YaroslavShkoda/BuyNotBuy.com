import Fastify from "fastify";
import { priceRoutes } from "./api/routes/price";

const app = Fastify({
    logger: true,
});

const PORT = 3001;

app.get('/', async () => {
    return {
        message: "BuyNotBuy backend is running",
    };
});

async function startServer() {
    await app.register(priceRoutes);

    app.listen({ port: PORT }, (error, adress) => {
        if (error) {
            app.log.error(error);
            process.exit(1);
        }

        console.log(`Server running at ${adress}`);
    });
}

startServer();