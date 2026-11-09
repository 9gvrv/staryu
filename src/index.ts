const args = Bun.argv.slice(2);
const appName = Bun.env.APP_NAME;
console.log("Arguments recieved: ", args, "\n& App name: ", appName, ".");

async function getGithubUser(username: string) {
  const response = await fetch(`https://api.github.com/users/${username}`, {
    headers: {
      "Content-Type": "application/json",
    },
  })
  const data = await response.json()
  console.log(data)
  return data
}
async function main() {
  const user = await getGithubUser(args[0])
  console.log(user)
}
main()
