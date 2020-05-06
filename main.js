var config = require('./config'),
    fs = require('fs'), 
    https = require('http'), 
    { spawn } = require('child_process'), 
    WebSocketServer = require('ws').Server,
    uuid = require('uuid');

var oxDNA;
var clients = [];
//Create a http server 
var httpServer = https.createServer();
httpServer.listen(config.serverPort);
console.log(`server listening on port ${config.serverPort}`);
//Setup the Socket
var wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (connection) => {
    // we need to know client index to remove them on 'close' event
    var index = clients.push(connection) - 1;
    console.log(`processes connected: ${clients.length}`);
    var user_id = uuid.v1();

    //create a work directory per connection
    let dir = `${config.simulation_folder}/${user_id}`    
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
    }

    connection.on('message', (message) => {
        //parse incomming congiguration
        let { type, settings, top_file, dat_file } = JSON.parse(message);
        
        //write topology and configuration into dedicated connection folder 
        fs.writeFileSync(`${dir}/conf_file.dat`, dat_file);
        fs.writeFileSync(`${dir}/last_conf.dat`, dat_file);
        fs.writeFileSync(`${dir}/top_file.top`, top_file);
        //write input and base parameter files 
        fs.copyFileSync(`./resources/input_pre_relax`,`${dir}/input_pre_relax`);
        fs.copyFileSync(`./resources/oxDNA2_sequence_dependent_parameters.txt`,`${dir}/oxDNA2_sequence_dependent_parameters.txt`);
        // perform simulation @ cwd = current working dir
        oxDNA = spawn(config.oxDNA, ['input_pre_relax'], { cwd: dir});
                
        // the trick is to have energy and conf file print settings to be the same
        oxDNA.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
            // than we can transfer data easily 
            connection.send(JSON.stringify({
                dat_file : fs.readFileSync(`${dir}/last_conf.dat`, 'utf8')
            }));
          });
              
        oxDNA.stderr.on('data', (data) => { console.error(`stderr: ${data}`); });
        oxDNA.on('close', (code) => {  });                    
        
    });
    // user disconnected
    connection.on('close', (connection) => {
        // remove user from the list of connected clients
        clients.splice(index, 1);

        //TODO: make somehow async or policy speciffic  
        fs.rmdirSync(dir, { recursive: true });
        console.log(`client ${index} id disconnected`);
        console.log(`removed assosiated working dir:`);
        console.log(dir);
        
        console.log(`processes connected: ${clients.length}`);
    });
});