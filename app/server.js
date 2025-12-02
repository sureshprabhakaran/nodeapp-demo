const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({status: 'ok'}));

app.listen(port, () => console.log(`Demo app listening on ${port}`));
