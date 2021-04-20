import {spawn, ChildProcess} from "child_process";
import * as uuid from "uuid";
import WebSocket,* as _ from 'ws';
import {mkdirSync, existsSync, writeFileSync, readFileSync,copyFileSync} from "fs";
import {rimraf} from "./lib/utils.js"
const config = JSON.parse(readFileSync('./resources/config.json', 'utf8'));


// at every restart we clear the simulations directory
rimraf(config.simulation_folder);
mkdirSync(config.simulation_folder);

//store the ox-view connection
var clients :Array<WebSocket> = new Array<WebSocket>();

//Setup the SocketServer
var wss = new WebSocket.Server({port: config.serverPort, host: config.serverIP });
console.log(`server listening on port ${config.serverPort}`);

wss.on('connection', (connection:WebSocket) => {
    let settings : Record<string,string>;
    var top_file : string , dat_file : string;
    var oxDNA:ChildProcess;
    
    // we need to know client index to remove them on 'close' event
    var index = clients.push(connection) - 1;
    console.log(`processes connected: ${clients.length}`);

    if (index >= config.allowed_connections) {
        console.log("refused connection");
        connection.close();
        return;
     } // limit connection numbers

    var user_id = uuid.v1();

    //create a work directory per connection
    let dir = `${config.simulation_folder}/${user_id}`
    if (!existsSync(dir)){
        mkdirSync(dir);
    }

    connection.on('message', (message: string) => {
        if (message === "abort") {
            //handle simulation stop
            if(oxDNA) oxDNA.kill();
            return;
        }
        //if relax is running kill it regardless of the message
        if(oxDNA) oxDNA.kill();
        //parse incomming congiguration
        var data = JSON.parse(message); 
        let useDNA = true;

        top_file = data.top_file;
        dat_file = data.dat_file;
        //inject oxDNA configuration settings
        settings = data.settings;
        Object.assign(settings,config.default_oxDNA_settings);

        console.log(settings["interaction_type"])
        if(settings["interaction_type"].includes("DNA")){
            useDNA = true;
            settings["seq_dep_file"]="oxDNA2_sequence_dependent_parameters.txt"
        }
        else if (settings["interaction_type"].includes("RNA")) {
            settings["seq_dep_file"]="rna_sequence_dependent_parameters.txt"
            useDNA = false;
        }
        
        if("trap_file" in data){
            settings["external_forces"] = "1";
            settings["external_forces_file"] = "trap.txt"
            //write forces file
            writeFileSync(`${dir}/trap.txt`, data.trap_file);
        }
        if("par_file" in data){
            settings["parfile"] = "par_file.par"
            //write par file (for anm)
            writeFileSync(`${dir}/par_file.par`, data.par_file);
        }

        //construct input file from transmitted settings
        let input_file = [];
        for(let [key, value] of Object.entries(settings)){
            input_file.push(`${key} = ${value}`)
        }


        //write topology and configuration into dedicated connection folder
        writeFileSync(`${dir}/conf_file.dat`, dat_file);
        writeFileSync(`${dir}/last_conf.dat`, dat_file);
        writeFileSync(`${dir}/top_file.top`,  top_file);


        //write input and base parameter files
        writeFileSync(`${dir}/${config.input_file}`, input_file.join('\n'));

        if(useDNA){
            copyFileSync(`./resources/oxDNA2_sequence_dependent_parameters.txt`,`${dir}/oxDNA2_sequence_dependent_parameters.txt`);
        }
        else{
            copyFileSync(`./resources/rna_sequence_dependent_parameters.txt`,`${dir}/rna_sequence_dependent_parameters.txt`);
        }
        // perform simulation @ cwd = current working dir
        oxDNA = spawn(config.oxDNA, [`${config.input_file}`], { cwd: dir});
        console.log(`connection ${index}\t|\trelax\t|\t started`);

        // the trick is to have energy and conf file print settings to be the same
        if (oxDNA.stdout){
            oxDNA.stdout.on('data', (data:string) => {
                console.log(`stdout: ${data}`);
                // than we can transfer data easily
                if (existsSync(`${dir}/last_conf.dat`)){
                    connection.send(JSON.stringify({
                        dat_file : readFileSync(`${dir}/last_conf.dat`, 'utf8'),
                        console_log: data.toString()
                    }));
                }
              });
        }

        if(oxDNA.stderr){
            oxDNA.stderr.on('data', (data:string) => {
                console.error(`stderr: ${data}`);
            });
        }

        oxDNA.on('close', (code : number) => {
            console.log(`connection ${index}\t|\trelax\t|\tfinished\t|\tcode: ${code}`);
            if (existsSync(`${dir}/last_conf.dat`)){
                connection.send(JSON.stringify({
                                 dat_file : readFileSync(`${dir}/last_conf.dat`, 'utf8'),
                                 console_log: data.toString()
                             }));
            }
        });
        
    });

    // user disconnected
    connection.on('close', (code : number) => {
        // remove user from the list of connected clients
        clients.splice(index, 1);
        if(oxDNA){
            //stop process just make sure no writing occures
            oxDNA.kill();
            //TODO: make somehow async or policy speciffic
            rimraf(dir);
            console.log(`client ${index} id disconnected\t|\tcode: ${code}`);
            console.log(`removed assosiated working dir:`);
            console.log(dir);
            console.log(`processes connected: ${clients.length}`);
        }
    });
});
