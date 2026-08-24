const { adminRequest } = require("./adminClient");
adminRequest(`query { shop { name email } }`)
.then((data) => console.log(JSON.stringify(data, null, 2)))
.catch(console.error);