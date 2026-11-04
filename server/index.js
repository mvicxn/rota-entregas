import app from "./app.js";

const PORT = process.env.PORT || 4015;

app.listen(PORT, () => {
  console.log(`Rota entregas API em http://localhost:${PORT}`);
});
