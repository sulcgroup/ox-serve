var config = require('./config'),
    fs = require('fs'),
    https = require('http'),
    { spawn } = require('child_process'),
    WebSocketServer = require('ws').Server,
    uuid = require('uuid'),
    path = require('path');

/**
 * Remove directory recursively
 * @param {string} dir_path
 * @see https://stackoverflow.com/a/42505874/3027390
 */
function rimraf(dir_path) {
    if (fs.existsSync(dir_path)) {
        fs.readdirSync(dir_path).forEach(function(entry) {
            var entry_path = path.join(dir_path, entry);
            if (fs.lstatSync(entry_path).isDirectory()) {
                rimraf(entry_path);
            } else {
                fs.unlinkSync(entry_path);
            }
        });
        fs.rmdirSync(dir_path);
    }
}

var oxDNA;
let settings = {}, top_file, dat_file;
var clients = [];
//Create a http server
var httpServer = https.createServer();
httpServer.listen(config.serverPort, config.serverIP);
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
        if (message === "abort") {
            //handle simulation stop
            if(oxDNA) oxDNA.kill();
            return;
        }
        //if relax is running kill it regardless of the message
        if(oxDNA) oxDNA.kill();
        //parse incomming congiguration
        var data = JSON.parse(message);

        //unfold data, cause we need settings to be defined before
        //as we use it in connection.on('close')
        //type     = data.type;
        settings = data.settings;
        top_file = data.top_file;
        dat_file = data.dat_file;

        //inject oxDNA configuration settings
        settings["conf_file"] = "conf_file.dat"
        settings["topology"] = "top_file.top"
        settings["trajectory_file"] = "/dev/null"//"trj.dat"
        settings["energy_file"] = "energy.dat"
        settings["lastconf_file"] = "last_conf.dat"
        settings["max_io"] = 10000
        if("trap_file" in data){
            settings["external_forces"] = 1
            settings["external_forces_file"] = "trap.txt"
            //write forces file
            fs.writeFileSync(`${dir}/trap.txt`, data.trap_file);
        }

        //console.log(settings);

        //construct input file from transmitted settings
        let input_file = [];
        for(let [key, value] of Object.entries(settings)){
            input_file.push(`${key} = ${value}`)
        }


        //write topology and configuration into dedicated connection folder
        fs.writeFileSync(`${dir}/conf_file.dat`, dat_file);
        fs.writeFileSync(`${dir}/last_conf.dat`, dat_file);
        fs.writeFileSync(`${dir}/top_file.top`, top_file);


        //write input and base parameter files
        //fs.copyFileSync(`./resources/${config.input_file}`,`${dir}/${config.input_file}`);
        fs.writeFileSync(`${dir}/${config.input_file}`, input_file.join('\n'));



        fs.copyFileSync(`./resources/oxDNA2_sequence_dependent_parameters.txt`,`${dir}/oxDNA2_sequence_dependent_parameters.txt`);
        // perform simulation @ cwd = current working dir
        oxDNA = spawn(config.oxDNA, [`${config.input_file}`], { cwd: dir});
        console.log(`connection ${index}\t|\trelax\t|\t started`);

        // the trick is to have energy and conf file print settings to be the same
        oxDNA.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
            // than we can transfer data easily
            if (fs.existsSync(`${dir}/last_conf.dat`)){
                connection.send(JSON.stringify({
                    dat_file : fs.readFileSync(`${dir}/last_conf.dat`, 'utf8'),
                    console_log: data.toString()
                }));
            }
          });

        oxDNA.stderr.on('data', (data) => {

            console.error(`stderr: ${data}`);
        });
        oxDNA.on('close', (code) => {
            console.log(`connection ${index}\t|\trelax\t|\t finished`);
            if (fs.existsSync(`${dir}/last_conf.dat`)){
                connection.send(JSON.stringify({
                                 dat_file : fs.readFileSync(`${dir}/last_conf.dat`, 'utf8'),
                                 console_log: data.toString()
                             }));
            }
        });
    });

    // user disconnected
    connection.on('close', (connection) => {
        // remove user from the list of connected clients
        clients.splice(index, 1);
        if (!settings.save_dir){
            if(oxDNA){
                //stop process just make sure no writing occures
                oxDNA.kill();
                //TODO: make somehow async or policy speciffic
                rimraf(dir);
                console.log(`client ${index} id disconnected`);
                console.log(`removed assosiated working dir:`);
                console.log(dir);
                console.log(`processes connected: ${clients.length}`);
            }
        }
    });
});
